#!/bin/sh
# PROTOTYPE, throwaway (issue #9). Builds the touch-prototype page for publishing as an Artifact:
# the real built game body + the touch overlay, minus the doctype/html/head the host supplies.
set -e
cd "$(dirname "$0")/../.."
npx webpack >/dev/null
{
  echo '<title>JNB Touch Prototype</title>'
  sed -n '/<style/,/<\/style>/p' game/index.html
  sed -n '/<body>/,/<\/body>/p' game/index.html | sed '1d' | sed 's|</body>||'
  cat prototype/touch/overlay.html
} > prototype/touch/artifact.html
echo "wrote prototype/touch/artifact.html"
