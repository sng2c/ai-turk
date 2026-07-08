import json, math, os, re, subprocess, urllib.request, urllib.error, uuid
from pathlib import Path
import streamlit as st

st.set_page_config(page_title="AI Turk", layout="centered")

# ── .env 로드 ─────────────────────────────────────────────────────────────
def _load_env():
    for p in [Path(__file__).parent / ".env", Path.home() / ".env"]:
        if p.exists():
            for line in p.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

_load_env()
OLLAMA_API_KEY = os.environ.get("OLLAMA_API_KEY", "")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "https://ollama.com/v1")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemini-3-flash-preview")
USE_API = bool(OLLAMA_API_KEY)

# ── 모바일 그리드 CSS (열 수를 동적으로 주입) ──────────────────────────────
def _grid_css(nc):
    return f"""<style>
:root {{ --grid-cols: {nc}; }}
@media (max-width: 768px) {{
  /* 모바일: 버튼 그리드는 가로 유지 */
  [data-testid="stHorizontalBlock"]:has(button):not(:has([data-testid="stNumberInput"])) {{
    display: grid !important;
    grid-template-columns: repeat(var(--grid-cols), 1fr) !important;
    gap: 2px !important;
  }}
  [data-testid="stHorizontalBlock"]:has(button):not(:has([data-testid="stNumberInput"])) > [data-testid="column"] {{
    display: contents !important;
  }}
  [data-testid="stHorizontalBlock"]:has(button):not(:has([data-testid="stNumberInput"])) button {{
    width: 100% !important;
    padding: 0.25rem 0.3rem !important;
    font-size: 0.72rem !important;
    line-height: 1.1 !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
  }}
  /* 모바일: 그리드 설정(N, 변경) 숨김 */
  [data-testid="stHorizontalBlock"]:has([data-testid="stNumberInput"]) {{
    display: none !important;
  }}
}}
/* 채팅창 하단 여백 제거 */
[data-testid="stChatInput"] {{ margin-bottom: 0 !important; padding-bottom: 0 !important; }}
.stChatInput {{ margin-bottom: 0 !important; padding-bottom: 0 !important; }}
[data-testid="stBottom"] {{ padding-bottom: 0 !important; }}
[data-testid="stChatInputArea"] {{ padding-bottom: 0 !important; }}
</style>"""

# ── 상태 초기화 ──────────────────────────────────────────────────────────
for k, v in {"n_rows": 5, "n_cols": 5, "initialized": False, "last_input": ""}.items():
    st.session_state.setdefault(k, v)
st.session_state.setdefault("session_id", f"turk_{uuid.uuid4().hex[:12]}")

st.markdown(_grid_css(st.session_state.n_cols), unsafe_allow_html=True)

def _reset():
    r, c = st.session_state.n_rows, st.session_state.n_cols
    st.session_state.current_state = {
        "message": f"그리드 {r}×{c} ({r*c}버튼) 준비됨",
        "buttons": {str(i): "" for i in range(r * c)},
    }
    st.session_state.initialized = False
    st.session_state.last_input = ""
    st.session_state.messages = None

if "current_state" not in st.session_state:
    _reset()

# ── 직접 API 호출 ─────────────────────────────────────────────────────────
def _api_call(messages, model):
    url = OLLAMA_BASE_URL.rstrip("/") + "/chat/completions"
    payload = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": 4096,
        "stream": False,
    }).encode()
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OLLAMA_API_KEY}",
    })
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    choice = data["choices"][0]["message"]
    return choice.get("content") or choice.get("reasoning", "")

# ── AI 호출 ──────────────────────────────────────────────────────────────
def _system_prompt():
    r, c, nb = st.session_state.n_rows, st.session_state.n_cols, st.session_state.n_rows * st.session_state.n_cols
    ex = ", ".join(f'"{i}": ""' for i in range(nb))
    return f"""[System Instruction]
UI 컨트롤러. 반드시 순수 JSON만 응답. 코드블록 금지.
버튼 {nb}개, {r}행×{c}열 그리드. 키 "0"~"{nb-1}".
빈 버튼은 "". 관련 기능은 같은 행, 주요 버튼은 가운데, 라벨은 간결하게(이모지 가능).
{{"message":"마크다운 텍스트","buttons":{{{ex}}}}}
"""

def _err(msg):
    buttons = {str(i): "" for i in range(st.session_state.n_rows * st.session_state.n_cols)}
    buttons["0"] = "다시 시도"
    return {"message": msg, "buttons": buttons}

def send(user_input):
    is_first = not st.session_state.initialized
    st.session_state.initialized = True
    st.session_state.last_input = user_input

    # ── 직접 API 경로 ──
    if USE_API:
        if is_first or st.session_state.get("messages") is None:
            st.session_state.messages = [{"role": "system", "content": _system_prompt()}]
        st.session_state.messages.append({"role": "user", "content": user_input})

        try:
            text = _api_call(st.session_state.messages, OLLAMA_MODEL)
            m = re.search(r"\{.*\}", text, re.DOTALL)
            if m:
                st.session_state.current_state = json.loads(m.group())
            else:
                st.session_state.current_state = _err(f"[파싱실패] {text[:200]}")
            st.session_state.messages.append({"role": "assistant", "content": text})
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:200]
            st.session_state.current_state = _err(f"[HTTP {e.code}] {body}")
        except Exception as e:
            st.session_state.current_state = _err(f"[API에러] {e}")
        return

    # ── pi CLI 폴백 ──
    prompt = f"{_system_prompt()}\n[User Input]\n{user_input}" if is_first else user_input
    cmd = ["pi", "--session-id", st.session_state.session_id, "-p", prompt]

    try:
        out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()
        m = re.search(r"\{.*\}", out, re.DOTALL)
        st.session_state.current_state = json.loads(m.group()) if m else _err(f"[파싱실패] {out}")
    except subprocess.CalledProcessError as e:
        st.session_state.current_state = _err(f"[CLI에러] {e.stderr}")
    except json.JSONDecodeError:
        st.session_state.current_state = _err(f"[JSON에러] {out}")

# ── UI ───────────────────────────────────────────────────────────────────
st.title("🤖 AI Turk")
mode_label = "API" if USE_API else "CLI"

# 그리드 설정
def _best_grid(n):
    c = max(1, min(round(math.sqrt(n)), 10))
    while n % c and c > 1: c -= 1
    return math.ceil(n / c), c

c0, _, c2, c3 = st.columns([3, 1.5, 0.7, 1.2])
c0.caption(f"🔑 `{st.session_state.session_id}` · {mode_label}")
total = c2.number_input("N", 1, 100, st.session_state.n_rows * st.session_state.n_cols,
                        step=1, label_visibility="collapsed", key="_total")
if c3.button("변경", use_container_width=True):
    st.session_state.n_rows, st.session_state.n_cols = _best_grid(int(total))
    _reset()
    st.rerun()

# 메시지
if st.session_state.last_input:
    st.caption(f"💬 {st.session_state.last_input}")
st.success(st.session_state.current_state["message"])

# 버튼 그리드
nc = st.session_state.n_cols
labels = st.session_state.current_state.get("buttons", {})
for r in range(st.session_state.n_rows):
    cols = st.columns(nc)
    for c in range(nc):
        idx = str(r * nc + c)
        lbl = labels.get(idx, "")
        if lbl:
            if cols[c].button(lbl, key=idx, use_container_width=True):
                send(lbl)
                st.rerun()
        else:
            cols[c].button(" ", key=idx, use_container_width=True, disabled=True)

# 입력
if t := st.chat_input("명령어 입력..."):
    send(t)
    st.rerun()