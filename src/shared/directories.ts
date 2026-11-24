import data from './directories.json';

/** A place to launch or list a product. A plain list: the agent reads each site's own rules and prices. */
export interface Directory {
  name: string;
  url: string;
  category: string;
}

export const DIRECTORIES: Directory[] = data;

export const CATEGORY_LABEL: Record<string, string> = {
  launch: 'Launch sites',
  'ai-directory': 'AI directories',
  'saas-directory': 'SaaS directories',
  'general-directory': 'General directories',
  'dev-directory': 'Developer directories',
  review: 'Review sites',
  community: 'Communities',
  profile: 'Profiles',
  press: 'Press',
  design: 'Design galleries',
  marketplace: 'Marketplaces',
};

export interface DirectoryFilter {
  search?: string;
  category?: string;
}

export function filterDirectories(f: DirectoryFilter): Directory[] {
  const search = f.search?.trim().toLowerCase();
  return DIRECTORIES.filter((d) => (!f.category || d.category === f.category) && (!search || `${d.name}\n${d.url}`.toLowerCase().includes(search)));
}

/** Reads the filters from a query string. An unknown category is ignored. */
export function parseDirectoryFilter(q: URLSearchParams): DirectoryFilter {
  const f: DirectoryFilter = {};
  const search = q.get('search')?.trim().slice(0, 100);
  const category = q.get('category');
  if (search) f.search = search;
  if (category && Object.hasOwn(CATEGORY_LABEL, category)) f.category = category;
  return f;
}

export function directoryQuery(f: DirectoryFilter): string {
  const q = new URLSearchParams();
  if (f.search?.trim()) q.set('search', f.search.trim());
  if (f.category) q.set('category', f.category);
  const s = q.toString();
  return s && `?${s}`;
}

/** The list in the categories' order, without the empty ones. */
export function byCategory(list: Directory[]): [string, Directory[]][] {
  return Object.keys(CATEGORY_LABEL)
    .map((c): [string, Directory[]] => [c, list.filter((d) => d.category === c)])
    .filter(([, rows]) => rows.length > 0);
}

export const DIRECTORY_NOTE = "A plain list of places to launch. Check each site's own rules and prices before submitting.";

export function directoriesMarkdown(list: Directory[]): string {
  const groups = byCategory(list).map(([c, rows]) => `## ${CATEGORY_LABEL[c]}\n\n${rows.map((d) => `- [${d.name.replace(/[[\]\\]/g, '\\$&')}](${d.url})`).join('\n')}`);
  return `${['# Launch directories', DIRECTORY_NOTE, ...groups].join('\n\n')}\n`;
}

/** What an owner pastes into their agent. */
export function agentPrompt(origin: string, f: DirectoryFilter): string {
  return `Fetch ${origin}/directories.json${directoryQuery(f)} for a list of places to launch. Ask me about my product, propose 3 to 5 that fit, and read each site's own rules and prices before preparing anything. Make one tagged link per place and draft the listing for my approval. Stop and ask me before creating an account, paying, accepting terms, verifying an email, solving a CAPTCHA or submitting. One submission per place.`;
}
