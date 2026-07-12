import { Component, type ReactNode } from "react";

// ── 에러 바운더리 (하얀 화면 방지) ──────────────────────────────────────
export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
	state = { hasError: false };
	static getDerivedStateFromError() { return { hasError: true }; }
	render() {
		if (this.state.hasError) {
			return (
				<div style={{ padding: 20, color: "#e6edf3", background: "#0e1117", minHeight: "100dvh", fontFamily: "sans-serif" }}>
					<p>⚠️ 렌더링 오류 발생</p>
					<button onClick={() => location.reload()} style={{ marginTop: 8, padding: "6px 16px", cursor: "pointer" }}>새로고침</button>
				</div>
			);
		}
		return this.props.children;
	}
}