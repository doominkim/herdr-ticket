#!/bin/sh
# Installs the app panel mod. The folder appears whole (built aside, then moved), because the app
# places a new mod folder it sees without mod.json into the layout on its own.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
dest="$mods/herdr-ticket"
tmp="$(dirname "$mods")/.herdr-ticket.new.$$" # outside mods/: the app never sees it half-made
rm -rf "$tmp"
mkdir -p "$tmp"
cp "$here/mods/herdr-ticket/mod.json" "$here/mods/herdr-ticket/"*.js "$here/mods/herdr-ticket/"*.svg "$tmp/"
[ -d "$dest" ] && cp "$dest"/gpui-kit.d.ts "$dest"/jsconfig.json "$tmp/" 2>/dev/null || true
rm -rf "$dest.old"
[ -d "$dest" ] && mv "$dest" "$dest.old"
mv "$tmp" "$dest"
rm -rf "$dest.old"
herdr-app check "$dest"
