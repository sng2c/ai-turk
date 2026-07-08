import streamlit as st
import math

st.set_page_config(page_title="🧮 계산기", layout="centered")

# ── 상태 초기화 ──────────────────────────────────────────────────────────
for k, v in {
    "expression": "",
    "display": "0",
    "history": [],
    "memory": 0.0,
    "last_result": None,
    "has_result": False,
}.items():
    st.session_state.setdefault(k, v)

# ── 유틸리티 ──────────────────────────────────────────────────────────────
SAFE_NAMES = {
    "abs": abs, "round": round,
    "sqrt": math.sqrt, "pow": pow,
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "log": math.log10, "ln": math.log, "log2": math.log2,
    "pi": math.pi, "e": math.e,
    "ceil": math.ceil, "floor": math.floor,
    "factorial": math.factorial,
}

def evaluate(expr: str) -> str:
    """수식을 안전하게 평가합니다."""
    expr = expr.replace("×", "*").replace("÷", "/").replace("^", "**")
    try:
        result = eval(expr, {"__builtins__": {}}, SAFE_NAMES)
        if isinstance(result, float) and result == int(result):
            result = int(result)
        # 부동소수점 자릿수 제한
        if isinstance(result, float):
            result = round(result, 12)
        return str(result)
    except ZeroDivisionError:
        return "오류: 0으로 나눌 수 없음"
    except Exception:
        return "오류: 잘못된 수식"

def press(key: str):
    """버튼 입력 처리"""
    s = st.session_state
    if key == "C":
        s.expression = ""
        s.display = "0"
        s.has_result = False
    elif key == "⌫":
        if s.has_result:
            s.expression = ""
            s.display = "0"
            s.has_result = False
        elif s.expression:
            s.expression = s.expression[:-1]
            s.display = s.expression if s.expression else "0"
    elif key == "±":
        if s.expression and s.expression[0] == "-":
            s.expression = s.expression[1:]
        elif s.expression:
            s.expression = "-" + s.expression
        s.display = s.expression if s.expression else "0"
    elif key == "=":
        result = evaluate(s.expression)
        s.history.append(f"{s.expression} = {result}")
        if len(s.history) > 50:
            s.history = s.history[-50:]
        s.display = result
        s.expression = result if not result.startswith("오류") else ""
        s.has_result = True
    elif key in ("sin", "cos", "tan", "log", "ln", "log2", "sqrt", "abs", "ceil", "floor", "factorial"):
        if s.has_result and not s.expression.startswith("오류"):
            s.expression = f"{key}({s.expression})"
            s.has_result = False
        else:
            s.expression += f"{key}("
        s.display = s.expression
    elif key in ("+", "-", "×", "÷", "^", "mod"):
        op = "mod" if key == "mod" else key
        if key == "×": op = "*"
        if key == "÷": op = "/"
        if key == "^": op = "**"
        s.expression += op
        s.has_result = False
        s.display = s.expression
    elif key == "(":
        s.expression += "("
        s.has_result = False
        s.display = s.expression
    elif key == ")":
        s.expression += ")"
        s.display = s.expression
    elif key == ".":
        s.expression += "."
        s.display = s.expression
    elif key == "π":
        s.expression += "pi"
        s.display = s.expression
    elif key == "e":
        s.expression += "e"
        s.display = s.expression
    elif key == "MC":
        s.memory = 0.0
    elif key == "MR":
        s.expression += str(s.memory)
        s.display = s.expression
    elif key == "M+":
        try:
            val = float(evaluate(s.expression)) if s.expression else 0
            s.memory += val
        except ValueError:
            pass
    elif key == "M−":
        try:
            val = float(evaluate(s.expression)) if s.expression else 0
            s.memory -= val
        except ValueError:
            pass
    else:  # 숫자
        if s.has_result:
            s.expression = key
            s.has_result = False
        else:
            s.expression += key
        s.display = s.expression

# ── CSS 스타일링 ──────────────────────────────────────────────────────────
st.markdown("""<style>
/* 디스플레이 */
.calc-display {
    background: #1a1a2e;
    color: #e0e0e0;
    font-family: 'Courier New', monospace;
    font-size: 2rem;
    text-align: right;
    padding: 0.75rem 1rem;
    border-radius: 12px;
    margin-bottom: 0.5rem;
    min-height: 3.5rem;
    overflow-x: auto;
    white-space: nowrap;
    border: 1px solid #333;
}
.calc-expr {
    font-size: 0.85rem;
    color: #888;
    min-height: 1.2rem;
}
/* 버튼 그리드 */
.calc-grid {
    display: grid;
    gap: 6px;
}
.calc-grid button {
    border-radius: 10px !important;
    font-size: 1.05rem !important;
    font-weight: 500 !important;
    min-height: 3rem !important;
    transition: all 0.1s !important;
}
.calc-grid button:hover {
    transform: scale(1.04);
    filter: brightness(1.1);
}
/* 버튼 색상 */
.btn-num { background: #2d2d44 !important; color: #fff !important; }
.btn-op  { background: #4a3f6b !important; color: #c9b3ff !important; }
.btn-fn  { background: #1b3a4b !important; color: #7ec8e3 !important; }
.btn-eq  { background: #6c3483 !important; color: #fff !important; font-size: 1.2rem !important; }
.btn-clr { background: #6b2737 !important; color: #ff8a8a !important; }
.btn-mem { background: #1a3c34 !important; color: #80cbc4 !important; font-size: 0.8rem !important; }
</style>""", unsafe_allow_html=True)

# ── 헤더 ──────────────────────────────────────────────────────────────────
st.title("🧮 계산기")

# ── 디스플레이 ───────────────────────────────────────────────────────────
expr_preview = st.session_state.expression if st.session_state.expression else ""
st.markdown(
    f'<div class="calc-display">'
    f'<div class="calc-expr">{expr_preview}</div>'
    f'<div>{st.session_state.display}</div>'
    f'</div>',
    unsafe_allow_html=True,
)

# ── 버튼 레이아웃 ────────────────────────────────────────────────────────
# 행별: [레이블, css클래스]
memory_row = [("MC","btn-mem"),("MR","btn-mem"),("M+","btn-mem"),("M−","btn-mem"),("π","btn-fn")]
fn_row     = [("sin","btn-fn"),("cos","btn-fn"),("tan","btn-fn"),("(","btn-op"),(")","btn-op")]
fn_row2    = [("log","btn-fn"),("ln","btn-fn"),("√","btn-fn"),("^","btn-op"),("mod","btn-op")]
fn_row3    = [("abs","btn-fn"),("x!","btn-fn"),("e","btn-fn"),("⌫","btn-clr"),("C","btn-clr")]
num_row1   = [("7","btn-num"),("8","btn-num"),("9","btn-num"),("÷","btn-op"),("±","btn-op")]
num_row2   = [("4","btn-num"),("5","btn-num"),("6","btn-num"),("×","btn-op"),("=","btn-eq")]
num_row3   = [("1","btn-num"),("2","btn-num"),("3","btn-num"),("−","btn-op"),("","")]
num_row4   = [("0","btn-num"),(".","btn-num"),("=","btn-eq"),("+","btn-op"),("","")]

# "√" → "sqrt", "x!" → "factorial", "−" → "-"
FUNC_MAP = {"√": "sqrt", "x!": "factorial", "−": "-"}

rows = [memory_row, fn_row, fn_row2, fn_row3, num_row1, num_row2, num_row3, num_row4]

cols_per_row = 5
st.markdown(f'<div class="calc-grid" style="grid-template-columns: repeat({cols_per_row}, 1fr);">', unsafe_allow_html=True)

for row in rows:
    rcols = st.columns(cols_per_row)
    for i, (label, css_cls) in enumerate(row):
        if not label:
            rcols[i].write("")
            continue
            # 빈 칸은 빈 div로
        mapped_label = FUNC_MAP.get(label, label)
        if rcols[i].button(label, key=f"btn_{label}_{row.index((label,css_cls))}_{rows.index(row)}", use_container_width=True):
            press(mapped_label)
            st.rerun()

st.markdown('</div>', unsafe_allow_html=True)

# ── 기록 ──────────────────────────────────────────────────────────────────
with st.expander("📜 계산 기록", expanded=False):
    if st.session_state.history:
        for h in reversed(st.session_state.history):
            st.text(h)
        if st.button("기록 전체 삭제"):
            st.session_state.history = []
            st.rerun()
    else:
        st.caption("아직 계산 기록이 없습니다.")