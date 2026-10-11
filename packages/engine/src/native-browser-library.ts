// The user's history and bookmarks, for questions like "that article I read last week" and for
// organizing bookmarks. Results are compact records; the code runtime gets them as plain data.
const MAX_RESULTS = 500;

type Request = Record<string, unknown>;

export function isLibraryRequest(value: Request | null): boolean {
  return Boolean(
    value && (typeof value.history === "string" || typeof value.bookmarks === "string"),
  );
}

export function libraryCall(value: Request): Promise<unknown> {
  if (typeof value.history === "string") return historyCall(value.history, value);
  return bookmarksCall(String(value.bookmarks), value);
}

async function historyCall(action: string, value: Request): Promise<unknown> {
  if (action !== "search") throw new Error("UNSUPPORTED: browser.history." + action);
  const days = Math.min(3650, Math.max(0, Number(value.days ?? 30)));
  const items = await chrome.history.search({
    text: String(value.text ?? ""),
    startTime: days ? Date.now() - days * 86_400_000 : 0,
    maxResults: limit(value.max, 50),
  });
  return items.map((item) => ({
    url: item.url,
    title: item.title,
    lastVisit: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : undefined,
    visits: item.visitCount,
  }));
}

async function bookmarksCall(action: string, value: Request): Promise<unknown> {
  const id = String(value.id ?? "");
  if (action === "search")
    return (await chrome.bookmarks.search(String(value.query ?? "")))
      .slice(0, limit(value.max, 100))
      .map(bookmark);
  if (action === "tree") return folderTree((await chrome.bookmarks.getTree())[0]);
  if (action === "children") return (await chrome.bookmarks.getChildren(id)).map(bookmark);
  if (action === "create") return bookmark(await chrome.bookmarks.create(fields(value)));
  if (action === "update") return bookmark(await chrome.bookmarks.update(id, fields(value)));
  if (action === "move")
    return bookmark(
      await chrome.bookmarks.move(id, fields(value) as { parentId?: string; index?: number }),
    );
  if (action === "remove") {
    if (value.recursive === true) await chrome.bookmarks.removeTree(id);
    else await chrome.bookmarks.remove(id);
    return { removed: id };
  }
  throw new Error("UNSUPPORTED: browser.bookmarks." + action);
}

function fields(value: Request): Record<string, string | number> {
  const picked: Record<string, string | number> = {};
  for (const key of ["parentId", "title", "url"])
    if (typeof value[key] === "string") picked[key] = value[key];
  if (typeof value.index === "number") picked.index = value.index;
  return picked;
}

function bookmark(node: chrome.bookmarks.BookmarkTreeNode) {
  return {
    id: node.id,
    title: node.title,
    ...(node.url ? { url: node.url } : { folder: true }),
    parentId: node.parentId,
  };
}

// Folders only, with how many links each holds: the full tree can be thousands of links.
function folderTree(node: chrome.bookmarks.BookmarkTreeNode | undefined): unknown {
  if (!node) return undefined;
  const children = node.children ?? [];
  return {
    id: node.id,
    title: node.title,
    links: children.filter((child) => child.url).length,
    folders: children.filter((child) => !child.url).map(folderTree),
  };
}

function limit(value: unknown, fallback: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number)
    ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(number)))
    : fallback;
}
