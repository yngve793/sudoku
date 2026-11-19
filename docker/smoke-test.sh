#!/usr/bin/env bash
# End-to-end smoke test of the running compose stack, through the public nginx port only.
#
#   docker compose up --build -d --wait
#   ./docker/smoke-test.sh
#
# register -> verification mail via the Mailpit API -> verify -> login (cookie jar) ->
# games at easy and extreme -> hint stages 1-3 -> PATCH autosave -> refresh -> leaderboard.
# Needs bash, curl and python3. Env: APP_URL (default http://localhost:8080),
# MAILPIT_URL (default http://localhost:8025).
set -euo pipefail

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

echo "== public leaderboard"
curl -fsS "$B/leaderboard?difficulty=easy&period=all" | j '"entries=%d" % len(d["entries"])'

echo "smoke test passed"
