// The display name a host gave an owner (a chat, routine or outside session). Grouping reads it
// when an openTab step did not carry one; a browserkit-only host leaves it empty and gets "Agent".
const titles = new Map<string, string>();

export function setOwnerTitle(owner: string, title: string | undefined): void {
  if (!title) return;
  titles.set(owner, title.trim().slice(0, 120));
}

export function ownerTitle(owner: string): string | undefined {
  return titles.get(owner);
}
