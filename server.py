# -*- coding: utf-8 -*-
"""
ИИ-психолог — бэкенд (FastAPI + SQLite + DeepSeek).
Запуск:  uvicorn server:app --reload --port 8000
"""
import os
import hmac
import json
import hashlib
import sqlite3
import secrets
import datetime as dt
from contextlib import contextmanager

import httpx
import edge_tts
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return f"{salt}${digest}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, digest = stored.split("$")
    except ValueError:
        return False
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return hmac.compare_digest(check, digest)

from prompts import (
    PSYCHOLOGISTS, ONBOARDING_QUESTIONS,
    build_session_prompt, SUMMARY_SYSTEM_PROMPT,
)

load_dotenv()
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DB_PATH = os.path.join(os.path.dirname(__file__), "app.db")

app = FastAPI(title="AI Psychologist")

# ----------------------------- БАЗА ДАННЫХ -----------------------------
@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            name TEXT DEFAULT '',
            age TEXT DEFAULT '',
            about TEXT DEFAULT '',
            answers TEXT DEFAULT '{}',          -- ответы онбординга (JSON)
            onboarded INTEGER DEFAULT 0,
            balance REAL DEFAULT 1000.0,        -- демо-баланс
            card_last4 TEXT DEFAULT '',
            default_psychologist TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS tokens (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            psychologist_id TEXT NOT NULL,
            started TEXT NOT NULL,
            ended TEXT,
            messages TEXT DEFAULT '[]',         -- стенограмма (JSON)
            summary TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            psychologist_id TEXT NOT NULL,
            slot TEXT NOT NULL,                 -- ISO дата-время
            notified INTEGER DEFAULT 0
        );
        """)


init_db()

SESSION_PRICE = 100.0  # демо-цена сессии

# ----------------------------- АВТОРИЗАЦИЯ -----------------------------
def auth(authorization: str | None) -> sqlite3.Row:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Не авторизован")
    token = authorization[7:]
    with db() as c:
        row = c.execute(
            "SELECT u.* FROM tokens t JOIN users u ON u.id=t.user_id WHERE t.token=?",
            (token,),
        ).fetchone()
    if not row:
        raise HTTPException(401, "Сессия истекла, войдите заново")
    return row


class Credentials(BaseModel):
    email: str
    password: str


@app.post("/api/register")
def register(body: Credentials):
    email = body.email.strip().lower()
    if not email or len(body.password) < 6:
        raise HTTPException(400, "Укажите email и пароль не короче 6 символов")
    with db() as c:
        if c.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            raise HTTPException(400, "Такой email уже зарегистрирован")
        c.execute(
            "INSERT INTO users (email, password_hash) VALUES (?,?)",
            (email, hash_password(body.password)),
        )
    return login(body)


@app.post("/api/login")
def login(body: Credentials):
    email = body.email.strip().lower()
    with db() as c:
        user = c.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if not user or not verify_password(body.password, user["password_hash"]):
            raise HTTPException(400, "Неверный email или пароль")
        token = secrets.token_hex(24)
        c.execute(
            "INSERT INTO tokens VALUES (?,?,?)",
            (token, user["id"], dt.datetime.now().isoformat()),
        )
    return {"token": token, "onboarded": bool(user["onboarded"])}


# ----------------------------- ПРОФИЛЬ И ОНБОРДИНГ -----------------------------
class ProfileUpdate(BaseModel):
    name: str = ""
    age: str = ""
    about: str = ""
    answers: dict = {}


@app.get("/api/profile")
def get_profile(authorization: str | None = Header(None)):
    u = auth(authorization)
    return {
        "email": u["email"], "name": u["name"], "age": u["age"], "about": u["about"],
        "answers": json.loads(u["answers"]), "onboarded": bool(u["onboarded"]),
        "balance": u["balance"], "card_last4": u["card_last4"],
        "default_psychologist": u["default_psychologist"],
    }


@app.put("/api/profile")
def update_profile(body: ProfileUpdate, authorization: str | None = Header(None)):
    u = auth(authorization)
    with db() as c:
        c.execute(
            "UPDATE users SET name=?, age=?, about=?, answers=?, onboarded=1 WHERE id=?",
            (body.name.strip(), body.age.strip(), body.about.strip(),
             json.dumps(body.answers, ensure_ascii=False), u["id"]),
        )
    return {"ok": True}


@app.get("/api/onboarding")
def onboarding():
    return {"questions": ONBOARDING_QUESTIONS}


# ----------------------------- ПСИХОЛОГИ -----------------------------
@app.get("/api/psychologists")
def psychologists():
    return {"psychologists": [
        {k: p[k] for k in ("id", "name", "gender", "avatar", "specialty", "description", "voice_hint")}
        for p in PSYCHOLOGISTS
    ]}


class DefaultPsy(BaseModel):
    psychologist_id: str


@app.post("/api/psychologists/default")
def set_default(body: DefaultPsy, authorization: str | None = Header(None)):
    u = auth(authorization)
    with db() as c:
        c.execute("UPDATE users SET default_psychologist=? WHERE id=?",
                  (body.psychologist_id, u["id"]))
    return {"ok": True}


def get_psy(pid: str) -> dict:
    for p in PSYCHOLOGISTS:
        if p["id"] == pid:
            return p
    raise HTTPException(404, "Психолог не найден")


# ----------------------------- DEEPSEEK -----------------------------
async def deepseek_chat(messages: list, temperature: float = 0.8) -> str:
    if not DEEPSEEK_API_KEY:
        raise HTTPException(500, "DEEPSEEK_API_KEY не задан. Создайте файл .env (см. .env.example)")
    async with httpx.AsyncClient(timeout=90) as client:
        r = await client.post(
            DEEPSEEK_URL,
            headers={"Authorization": f"Bearer {DEEPSEEK_API_KEY}"},
            json={"model": DEEPSEEK_MODEL, "messages": messages, "temperature": temperature},
        )
    if r.status_code != 200:
        raise HTTPException(502, f"Ошибка DeepSeek: {r.status_code} {r.text[:300]}")
    return r.json()["choices"][0]["message"]["content"].strip()


# ----------------------------- СЕССИИ -----------------------------
class StartSession(BaseModel):
    psychologist_id: str


@app.post("/api/session/start")
async def start_session(body: StartSession, authorization: str | None = Header(None)):
    u = auth(authorization)
    if u["balance"] < SESSION_PRICE:
        raise HTTPException(402, f"Недостаточно средств. Сессия стоит {SESSION_PRICE:.0f} ₽, пополните баланс в профиле.")
    psy = get_psy(body.psychologist_id)
    profile = {"name": u["name"], "age": u["age"], "about": u["about"]}
    system = build_session_prompt(psy, profile, json.loads(u["answers"]))
    greeting = await deepseek_chat([
        {"role": "system", "content": system},
        {"role": "user", "content": "(Клиент подключился к сессии. Поприветствуй его и начни встречу.)"},
    ])
    msgs = [{"role": "system", "content": system}, {"role": "assistant", "content": greeting}]
    with db() as c:
        c.execute("UPDATE users SET balance=balance-? WHERE id=?", (SESSION_PRICE, u["id"]))
        cur = c.execute(
            "INSERT INTO sessions (user_id, psychologist_id, started, messages) VALUES (?,?,?,?)",
            (u["id"], psy["id"], dt.datetime.now().isoformat(), json.dumps(msgs, ensure_ascii=False)),
        )
        sid = cur.lastrowid
    return {"session_id": sid, "reply": greeting}


class SessionMessage(BaseModel):
    session_id: int
    text: str


@app.post("/api/session/message")
async def session_message(body: SessionMessage, authorization: str | None = Header(None)):
    u = auth(authorization)
    with db() as c:
        s = c.execute("SELECT * FROM sessions WHERE id=? AND user_id=?",
                      (body.session_id, u["id"])).fetchone()
    if not s or s["ended"]:
        raise HTTPException(404, "Сессия не найдена или завершена")
    msgs = json.loads(s["messages"])
    msgs.append({"role": "user", "content": body.text.strip()})
    reply = await deepseek_chat(msgs)
    msgs.append({"role": "assistant", "content": reply})
    with db() as c:
        c.execute("UPDATE sessions SET messages=? WHERE id=?",
                  (json.dumps(msgs, ensure_ascii=False), s["id"]))
    return {"reply": reply}


class EndSession(BaseModel):
    session_id: int


@app.post("/api/session/end")
async def end_session(body: EndSession, authorization: str | None = Header(None)):
    u = auth(authorization)
    with db() as c:
        s = c.execute("SELECT * FROM sessions WHERE id=? AND user_id=?",
                      (body.session_id, u["id"])).fetchone()
    if not s:
        raise HTTPException(404, "Сессия не найдена")
    if s["ended"]:
        return {"summary": s["summary"]}
    msgs = json.loads(s["messages"])
    transcript = "\n".join(
        f"{'Клиент' if m['role'] == 'user' else 'Психолог'}: {m['content']}"
        for m in msgs if m["role"] != "system"
    )
    summary = "Сессия была слишком короткой для резюме."
    if sum(1 for m in msgs if m["role"] == "user") >= 1:
        try:
            summary = await deepseek_chat([
                {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": transcript},
            ], temperature=0.3)
        except HTTPException:
            summary = "Не удалось сгенерировать резюме (ошибка ИИ-сервиса)."
    with db() as c:
        c.execute("UPDATE sessions SET ended=?, summary=? WHERE id=?",
                  (dt.datetime.now().isoformat(), summary, s["id"]))
    return {"summary": summary}


@app.get("/api/sessions")
def list_sessions(authorization: str | None = Header(None)):
    u = auth(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT id, psychologist_id, started, ended, summary FROM sessions "
            "WHERE user_id=? AND ended IS NOT NULL ORDER BY started DESC", (u["id"],),
        ).fetchall()
    psy_names = {p["id"]: f'{p["avatar"]} {p["name"]}' for p in PSYCHOLOGISTS}
    return {"sessions": [
        {"id": r["id"], "psychologist": psy_names.get(r["psychologist_id"], "?"),
         "started": r["started"], "ended": r["ended"], "summary": r["summary"]}
        for r in rows
    ]}


# ----------------------------- РАСПИСАНИЕ -----------------------------
class Booking(BaseModel):
    psychologist_id: str
    slot: str  # ISO дата-время


@app.get("/api/bookings")
def bookings(authorization: str | None = Header(None)):
    u = auth(authorization)
    with db() as c:
        rows = c.execute(
            "SELECT * FROM bookings WHERE user_id=? AND slot >= ? ORDER BY slot",
            (u["id"], dt.datetime.now().isoformat()),
        ).fetchall()
    psy_names = {p["id"]: f'{p["avatar"]} {p["name"]}' for p in PSYCHOLOGISTS}
    return {"bookings": [
        {"id": r["id"], "psychologist_id": r["psychologist_id"],
         "psychologist": psy_names.get(r["psychologist_id"], "?"), "slot": r["slot"]}
        for r in rows
    ]}


@app.post("/api/bookings")
def create_booking(body: Booking, authorization: str | None = Header(None)):
    u = auth(authorization)
    get_psy(body.psychologist_id)
    try:
        slot = dt.datetime.fromisoformat(body.slot)
    except ValueError:
        raise HTTPException(400, "Неверный формат даты")
    if slot < dt.datetime.now():
        raise HTTPException(400, "Нельзя забронировать время в прошлом")
    with db() as c:
        c.execute("INSERT INTO bookings (user_id, psychologist_id, slot) VALUES (?,?,?)",
                  (u["id"], body.psychologist_id, slot.isoformat()))
    return {"ok": True}


@app.delete("/api/bookings/{booking_id}")
def delete_booking(booking_id: int, authorization: str | None = Header(None)):
    u = auth(authorization)
    with db() as c:
        c.execute("DELETE FROM bookings WHERE id=? AND user_id=?", (booking_id, u["id"]))
    return {"ok": True}


# ----------------------------- ОЗВУЧКА (Edge-TTS) -----------------------------
# Нейроголоса Microsoft: бесплатно, отличное качество для русского языка.
# Каждому психологу — свой голос и манера речи (темп/высота).
TTS_VOICES = {
    "anna":    {"voice": "ru-RU-SvetlanaNeural", "rate": "+9%",  "pitch": "+0Hz"},
    "mikhail": {"voice": "ru-RU-DmitryNeural",   "rate": "+23%", "pitch": "+2Hz"},
    "sofia":   {"voice": "ru-RU-SvetlanaNeural", "rate": "+13%", "pitch": "+4Hz"},
    "viktor":  {"voice": "ru-RU-DmitryNeural",   "rate": "+3%",  "pitch": "-4Hz"},
}
DEFAULT_TTS = {"voice": "ru-RU-SvetlanaNeural", "rate": "+15%", "pitch": "+0Hz"}


class TTSRequest(BaseModel):
    text: str
    psychologist_id: str = ""


@app.post("/api/tts")
async def tts(body: TTSRequest, authorization: str | None = Header(None)):
    auth(authorization)
    text = body.text.strip()[:4000]
    if not text:
        raise HTTPException(400, "Пустой текст")
    cfg = TTS_VOICES.get(body.psychologist_id, DEFAULT_TTS)
    communicate = edge_tts.Communicate(
        text, cfg["voice"], rate=cfg["rate"], pitch=cfg["pitch"],
    )

    async def audio_stream():
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                yield chunk["data"]

    return StreamingResponse(audio_stream(), media_type="audio/mpeg")


# ----------------------------- БАЛАНС (демо) -----------------------------
class TopUp(BaseModel):
    amount: float


@app.post("/api/balance/topup")
def topup(body: TopUp, authorization: str | None = Header(None)):
    u = auth(authorization)
    if body.amount <= 0 or body.amount > 100000:
        raise HTTPException(400, "Неверная сумма")
    if not u["card_last4"]:
        raise HTTPException(400, "Сначала привяжите карту")
    with db() as c:
        c.execute("UPDATE users SET balance=balance+? WHERE id=?", (body.amount, u["id"]))
        bal = c.execute("SELECT balance FROM users WHERE id=?", (u["id"],)).fetchone()[0]
    return {"balance": bal}


class Card(BaseModel):
    number: str


@app.post("/api/card")
def bind_card(body: Card, authorization: str | None = Header(None)):
    u = auth(authorization)
    digits = "".join(ch for ch in body.number if ch.isdigit())
    if len(digits) != 16:
        raise HTTPException(400, "Номер карты должен содержать 16 цифр")
    # ДЕМО: номер карты НЕ сохраняется, только последние 4 цифры
    with db() as c:
        c.execute("UPDATE users SET card_last4=? WHERE id=?", (digits[-4:], u["id"]))
    return {"card_last4": digits[-4:]}


# ----------------------------- СТАТИКА -----------------------------
static_dir = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=static_dir), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(static_dir, "index.html"))
