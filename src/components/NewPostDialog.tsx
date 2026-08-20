import { useState } from "react";

export interface NewPostDialogProps {
  open: boolean;
  folders: string[];
  onCancel: () => void;
  onCreate: (title: string, folder?: string) => void;
}

/** 新建文稿对话框：标题必填；目录 = 现有 folder 下拉 或 新建目录 */
export function NewPostDialog({ open, folders, onCancel, onCreate }: NewPostDialogProps) {
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  if (!open) return null;

  const confirm = () => {
    if (!title.trim()) return;
    const f = creatingFolder && newFolder.trim() ? newFolder.trim() : folder || undefined;
    onCreate(title.trim(), f);
    setTitle("");
    setFolder("");
    setNewFolder("");
    setCreatingFolder(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" data-testid="new-post-dialog">
      <div className="w-[380px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl">
        <h3 className="mb-3 text-base font-bold">新建文稿</h3>
        <input
          autoFocus
          data-testid="new-post-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && confirm()}
          placeholder="标题（显示名，与文件名无关）"
          className="mb-3 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
        />
        {creatingFolder ? (
          <input
            data-testid="new-folder-name"
            autoFocus
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="新目录路径，如 技术/分布式"
            className="mb-3 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
          />
        ) : (
          <select
            data-testid="new-post-folder"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            className="mb-3 w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none"
          >
            <option value="">未分类</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        )}
        <button
          className="mb-3 text-[11px] text-[var(--cat)]"
          onClick={() => setCreatingFolder(!creatingFolder)}
          data-testid="toggle-new-folder"
        >
          {creatingFolder ? "← 选择现有目录" : "+ 新建目录…"}
        </button>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
            取消
          </button>
          <button
            onClick={confirm}
            data-testid="new-post-confirm"
            className="rounded-lg bg-[var(--cat)] px-3 py-1.5 text-[13px] font-semibold text-white"
          >
            创建
          </button>
        </div>
      </div>
    </div>
  );
}
