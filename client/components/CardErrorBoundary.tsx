import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * A2UI v2 (S4): confine a malformed card's crash to its own slot. Legacy
 * history can contain <a2ui-json> blocks that parsed but are malformed at
 * render time (null items, wrong field shapes); the client has no global
 * ErrorBoundary, so one bad card used to white-screen the whole message
 * list. Degrade to a notice instead.
 */
export class CardErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[A2UI] card render failed:", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="my-3 border border-gray-200 bg-gray-50 rounded-lg px-4 py-3 text-sm text-gray-500">
          该卡片无法渲染（数据格式异常）
        </div>
      );
    }
    return this.props.children;
  }
}
