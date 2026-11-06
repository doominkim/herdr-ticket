import { div } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { closeOverlay, props, theme } from "herdr";
import { tk } from "./commands.js";
import { isDarkBackground } from "./presentation.js";

const DETAILS = {
  high: { label: "High", light: "#B94242", dark: "#E57A7A" },
  medium: { label: "Medium", light: "#A77B0D", dark: "#DDB34C" },
  low: { label: "Low", light: "#3E73C7", dark: "#7EA7E7" },
};
const CHOICES = [[null, "None"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]];

export function priorityColor(value, dark) {
  const p = DETAILS[value];
  return p ? (dark ? p.dark : p.light) : null;
}

export function priorityMark(t, value, dark) {
  const p = DETAILS[value];
  if (!p) return null;
  return h_flex().flex_none().gap(4).items_center().text_size(10).text_color(t.foreground)
    .tooltip(`Priority: ${p.label}`).accessibility_label(`Priority: ${p.label}`)
    .child(div().size(5).rounded(3).bg(priorityColor(value, dark)))
    .child(p.label);
}

export function priorityChoices(t, id, selected, busy, choose, dark) {
  return h_flex().gap(6).flex_wrap().children(CHOICES.map(([value, label]) =>
    Button.new(`${id}-${value ?? "none"}`).tab_index(0).px(10).py(7).rounded(6).border_1()
      .border_color(value === selected ? t.accent : t.border).bg(value === selected ? t.selected : t.raised)
      .text_color(t.foreground).text_size(12).selected(value === selected).disabled(busy)
      .accessibility_label(`Priority: ${label}`).hover(el => el.bg(t.hover)).cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); if (!busy) choose(value, cx); })
      .child(h_flex().gap(6).items_center()
        .when(value !== null, el => el.child(div().size(6).rounded(3).bg(priorityColor(value, dark))))
        .child(label))));
}

export class PriorityEditor {
  init(input, cx) {
    const p = input ?? props() ?? {};
    this.root = p.root;
    this.ref = p.ref;
    this.overlay = p.overlay ?? props()?.overlay;
    this.loading = true;
    this.busy = false;
    this.disposed = false;
    this.original = undefined;
    this.value = null;
    this.error = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async acx => {
      try {
        const ticket = await tk(["show", this.ref, "--latest-handoff"], this.root);
        if (this.disposed) return;
        this.original = ticket.priority ?? null;
        this.value = this.original;
      } catch (error) {
        if (!this.disposed) this.error = `Load failed: ${String(error?.message ?? error)}`;
      } finally {
        this.loading = false;
        if (!this.disposed) acx.notify();
      }
    });
  }

  close() { if (!this.busy) closeOverlay(this.overlay); }
  dispose() { this.disposed = true; this.handle.release(); }

  submit(cx) {
    if (this.loading || this.busy || this.disposed || this.original === undefined) return;
    if (this.value === this.original) { this.close(); return; }
    const args = ["edit", this.ref, `--priority=${this.value ?? ""}`];
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async acx => {
      try {
        await tk(args, this.root, { attachSession: false });
        if (!this.disposed) closeOverlay(this.overlay);
      } catch (error) {
        if (this.disposed) return;
        this.busy = false;
        this.error = `Save failed: ${String(error?.message ?? error)}`;
        acx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const action = (id, label, run, primary = false) => Button.new(id).tab_index(0).h(32).px(9).items_center().rounded(5).border_1()
      .border_color(primary ? t.solid ?? t.accent : t.border).bg(primary ? t.solid ?? t.accent : t.raised)
      .text_color(primary ? t.solid_foreground ?? t.background : t.foreground).text_size(11)
      .disabled(this.busy || (primary && (this.loading || this.original === undefined)))
      .hover(el => el.border_color(t.accent)).focus(el => el.border_color(t.accent)).cursor_pointer().on_click(run).child(label);
    const root = v_flex().id("tk-priority-dialog").size_full().min_h(0).p(18).gap(12)
      .bg(t.popover).text_color(t.foreground).text_size(12.5).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "enter" && e.modifiers.platform) this.submit(cx);
        else return;
        cx.stop_propagation();
      })
      .child(div().text_size(17).font_semibold().child(`Priority · ${this.ref}`));
    if (this.loading) root.child(div().role("status").child("Loading ticket…"));
    else if (this.original !== undefined) root.child(priorityChoices(t, "tk-edit-priority", this.value, this.busy, (value, cx) => {
      if (!this.busy) { this.value = value; this.error = null; cx.notify(); }
    }, isDarkBackground(t.background)));
    if (this.error) root.child(div().role("alert").text_size(12).whitespace_normal().child(this.error));
    return root.child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(action("tk-priority-cancel", "Cancel", () => this.close()))
        .child(action("tk-priority-save", this.busy ? "Saving…" : "Save", (_e, cx) => this.submit(cx), true)));
  }
}
