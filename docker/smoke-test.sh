#!/usr/bin/env bash
# End-to-end smoke test of the running compose stack, through the public nginx port only.
#
#   docker compose up --build -d --wait
#   ./docker/smoke-test.sh
#
# register -> verification mail via the Mailpit API -> verify -> login (cookie jar) ->
# games at easy and extreme -> hint stages 1-3 -> PATCH autosave -> refresh -> photo import
# (check, import, recognize through nginx's 11m location, 12 MB -> 413 JSON) -> leaderboard.
# Needs bash, curl and python3. Env: APP_URL (default http://localhost:8080),
# MAILPIT_URL (default http://localhost:8025).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

APP=${APP_URL:-http://localhost:8080}
B=$APP/api/v1
M=${MAILPIT_URL:-http://localhost:8025}/api/v1
D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
JAR=$D/jar
U="smoke$RANDOM$RANDOM"
EMAIL="$U@example.com"
PW='correct-horse-battery-staple'

# j EXPR < json  -- evaluate a Python expression over the parsed JSON document `d`.
j() { python3 -c 'import sys, json; d = json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }
post() { curl -fsS -H 'Content-Type: application/json' "$@"; }

echo "== register $EMAIL"
post -d "{\"username\":\"$U\",\"email\":\"$EMAIL\",\"password\":\"$PW\"}" "$B/auth/register" | j 'd["message"]'

echo "== verification mail (Mailpit)"
ID=""
for _ in $(seq 1 40); do
  ID=$(curl -fsS "$M/search?query=to:$EMAIL" | j 'd["messages"][0]["ID"] if d["messages"] else ""')
  [ -n "$ID" ] && break
  sleep 0.5
done
[ -n "$ID" ] || { echo "no verification email arrived" >&2; exit 1; }
curl -fsS "$M/message/$ID" > "$D/msg"
TOKEN=$(j 'd["Text"]' < "$D/msg" | grep -oE 'verify-email\?token=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "no token in verification email" >&2; exit 1; }
echo "subject: $(j 'd["Subject"]' < "$D/msg")"

echo "== verify + login"
post -d "{\"token\":\"$TOKEN\"}" "$B/auth/verify-email" | j 'd["message"]'
post -c "$JAR" -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}" "$B/auth/login" > "$D/login"
AT=$(j 'd["access_token"]' < "$D/login")
grep -q 'refresh_token' "$JAR" || { echo "no refresh cookie set" >&2; exit 1; }
H="Authorization: Bearer $AT"

echo "== new games"
post -H "$H" -d '{"difficulty":"easy"}' "$B/games" \
  | j '"easy: id=%s solution_leaked=%s" % (d["id"], "solution" in d)'
post -H "$H" -d '{"difficulty":"extreme"}' "$B/games" > "$D/g"
j '"extreme: id=%s difficulty=%s" % (d["id"], d["difficulty"])' < "$D/g"
GID=$(j 'd["id"]' < "$D/g")
CUR=$(j 'd["current"]' < "$D/g")
GIV=$(j 'd["givens"]' < "$D/g")

echo "== hints"
for s in 1 2 3; do
  post -H "$H" -d "{\"stage\":$s,\"current\":\"$CUR\"}" "$B/games/$GID/hint" \
    | j '"stage %s: %s %s value=%s" % (d["stage"], d["kind"], d["technique"], d["value"])'
done

echo "== autosave + refresh"
VER=$(curl -fsS -H "$H" "$B/games/$GID" | j 'd["version"]')
post -X PATCH -H "$H" \
  -d "{\"current\":\"$CUR\",\"notes\":{\"0\":[1,2]},\"elapsed_seconds\":42,\"version\":$VER}" \
  "$B/games/$GID" | j '"version=%s hints_used=%s" % (d["version"], d["hints_used"])'
curl -fsS -b "$JAR" -c "$JAR" -X POST "$B/auth/refresh" > "$D/ref"
AT2=$(j 'd["access_token"]' < "$D/ref")
curl -fsS -o /dev/null -H "Authorization: Bearer $AT2" "$B/me"
echo "refresh ok"

echo "== photo import: check + import"
post -H "$H" -d "{\"givens\":\"$GIV\",\"current\":\"$GIV\"}" "$B/imports/check" \
  | j '"consistent=%s solutions=%s difficulty=%s leaked=%s" % (d["consistent"], d["solution_count"], d["difficulty"], "solution" in d)'
post -H "$H" -d "{\"givens\":\"$GIV\",\"current\":\"$GIV\"}" "$B/games/import" > "$D/imp"
j '"imported: id=%s source=%s difficulty=%s" % (d["id"], d["source"], d["difficulty"])' < "$D/imp"
[ "$(j 'd["source"]' < "$D/imp")" = imported ] || { echo "import: source is not 'imported'" >&2; exit 1; }

# upload FILE EXPECTED_STATUS EXPECTED_CODE -- multipart POST to /imports/recognize through
# nginx; checks the status and, for errors, that the body is a JSON ErrorOut with that code.
upload() {
  local status
  status=$(curl -sS -o "$D/up" -w '%{http_code}' -H "$H" -F "file=@$1;type=image/jpeg" \
    "$B/imports/recognize" || true)
  if [ "$status" != "$2" ]; then
    echo "recognize $(basename "$1"): expected HTTP $2, got $status: $(head -c 300 "$D/up")" >&2
    exit 1
  fi
  if [ -n "${3:-}" ]; then
    j '"HTTP %s code=%s" % ('"$status"', d["code"]) if d["code"] == "'"$3"'" and "detail" in d else exit("unexpected body: %r" % d)' < "$D/up"
  fi
}

echo "== photo import: recognize (nginx 11m location)"
# 1 MiB of non-image bytes: over /api/'s 64k, so a JSON 415 from the API proves the request
# went through the dedicated location (nginx would answer 413 otherwise).
head -c 1048576 /dev/zero > "$D/blob.jpg"
upload "$D/blob.jpg" 415 unsupported_image
# A committed synthetic fixture (vision/tests/fixtures): proves the model ships and loads.
PHOTO=$ROOT/vision/tests/fixtures/synth_7_00.jpg
[ -f "$PHOTO" ] || { echo "missing fixture photo $PHOTO" >&2; exit 1; }
upload "$PHOTO" 200
j '"%s: cells=%d grid_confidence=%.2f digits=%d" % ("synth_7_00.jpg", len(d["cells"]), d["grid_confidence"], sum(1 for c in d["cells"] if c["digit"])) if len(d["cells"]) == 81 else exit("expected 81 cells, got %d" % len(d["cells"]))' < "$D/up"
# 12 MB: rejected by nginx (client_max_body_size 11m) as a JSON ErrorOut, not an HTML page.
head -c 12582912 /dev/zero > "$D/big.jpg"
upload "$D/big.jpg" 413 image_too_large

echo "== public leaderboard"
curl -fsS "$B/leaderboard?difficulty=easy&period=all" | j '"entries=%d" % len(d["entries"])'

echo "smoke test passed"
