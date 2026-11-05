import { TAG_COLORS } from "./tag-colors.js";

const normalize = value => value.trim().toLowerCase();
const valid = name => /^[a-z0-9-]{1,32}$/.test(name);

/** Dialog-local draft. Catalog updates never overwrite the user's selected names. */
export class TagSelection {
  constructor(names = []) {
    this.selected = [];
    this.catalog = [];
    this.error = null;
    for (const name of names) this.add(name);
  }

  names() { return [...this.selected]; }

  add(value) {
    const name = normalize(value);
    this.error = null;
    if (!valid(name)) {
      this.error = "Use 1–32 letters, digits or hyphens.";
      return false;
    }
    if (this.selected.includes(name)) return false;
    if (this.selected.length === 8) {
      this.error = "Up to 8 tags. Remove a selected tag to add another.";
      return false;
    }
    this.selected.push(name);
    return true;
  }

  remove(name) {
    this.selected = this.selected.filter(item => item !== name);
    this.error = null;
  }

  setCatalog(entries) { this.catalog = entries; }

  color(name) {
    const registered = this.catalog.find(entry => entry.name === name);
    if (registered) return registered.color;
    let next = this.catalog.length;
    for (const selected of this.selected) {
      if (this.catalog.some(entry => entry.name === selected)) continue;
      if (selected === name) return TAG_COLORS[next % TAG_COLORS.length];
      next++;
    }
    return TAG_COLORS[next % TAG_COLORS.length];
  }

  target(query) {
    const options = this.options(query);
    const exact = options.find(entry => entry.name === normalize(query));
    return exact?.name ?? this.createName(query) ?? options[0]?.name ?? null;
  }

  options(query) {
    const entries = [...this.catalog];
    for (const name of this.selected) {
      if (!entries.some(entry => entry.name === name)) entries.push({ name, color: null });
    }
    return entries.filter(entry => entry.name.includes(normalize(query)));
  }

  createName(query) {
    const name = normalize(query);
    return valid(name) && !this.catalog.some(entry => entry.name === name) && !this.selected.includes(name) ? name : null;
  }
}
