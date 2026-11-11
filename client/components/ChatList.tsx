import { MessageSquare, Plus, Sparkles, Trash2, LayoutGrid, Package } from "lucide-react";

interface Chat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatListProps {
  chats: Chat[];
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onNewChat: () => void;
  /** M6a: open the expert-builder drawer (primary journey). */
  onCreateAgent: () => void;
  /** M7a: open the My Experts directory (own agents list/edit/delete). */
  onOpenExperts: () => void;
  /** M7b: open the My Skills submission page (own submissions, submit). */
  onOpenMySkills: () => void;
  onDeleteChat: (chatId: string) => void;
}

export function ChatList({
  chats,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onCreateAgent,
  onOpenExperts,
  onOpenMySkills,
  onDeleteChat,
}: ChatListProps) {
  return (
    <div className="flex flex-col h-full min-h-0 bg-gray-50 border-r border-line-subtle">
      {/* Header */}
      <div className="p-3 border-b border-line-subtle shrink-0 space-y-1.5">
        <button
          onClick={onCreateAgent}
          className="w-full flex items-center justify-center gap-2 px-4 h-10 bg-brand hover:bg-brand-hover text-white font-medium rounded-lg transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          <span>创建 Agent</span>
        </button>
        <button
          onClick={onOpenExperts}
          className="w-full flex items-center justify-center gap-1.5 px-4 h-7 text-xs text-gray-500 hover:text-ink-primary hover:bg-gray-100 rounded-md transition-colors"
          data-testid="open-experts"
        >
          <LayoutGrid className="w-3 h-3" />
          <span>我的专家</span>
        </button>
        <button
          onClick={onOpenMySkills}
          className="w-full flex items-center justify-center gap-1.5 px-4 h-7 text-xs text-gray-500 hover:text-ink-primary hover:bg-gray-100 rounded-md transition-colors"
          data-testid="open-my-skills"
        >
          <Package className="w-3 h-3" />
          <span>我的技能</span>
        </button>
        <button
          onClick={onNewChat}
          className="w-full flex items-center justify-center gap-1.5 px-4 h-7 text-xs text-gray-500 hover:text-ink-primary hover:bg-gray-100 rounded-md transition-colors"
        >
          <Plus className="w-3 h-3" />
          <span>新建空白对话</span>
        </button>
      </div>

      {/* Chat list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {chats.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-sm text-ink-secondary">暂无对话</p>
            <p className="text-xs mt-1 text-gray-400">选择或创建一个对话开始</p>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {chats.map((chat) => {
              const active = selectedChatId === chat.id;
              return (
                <div
                  key={chat.id}
                  className={`group flex items-center gap-2 px-2.5 py-2 rounded-md cursor-pointer transition-colors ${
                    active ? "bg-brand-soft" : "hover:bg-gray-100"
                  }`}
                  onClick={() => onSelectChat(chat.id)}
                >
                  <MessageSquare
                    className={`w-4 h-4 shrink-0 ${active ? "text-brand" : "text-gray-400"}`}
                  />
                  <span
                    className={`flex-1 truncate text-sm ${
                      active ? "text-brand font-medium" : "text-ink-primary"
                    }`}
                  >
                    {chat.title}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChat(chat.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 transition-all text-gray-400 hover:text-red-600"
                    title="删除对话"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-line-subtle shrink-0">
        <p className="text-xs text-gray-400 text-center">EAOS</p>
      </div>
    </div>
  );
}
