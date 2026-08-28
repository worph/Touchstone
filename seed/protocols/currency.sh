#!/bin/sh
# Image Currency — the procedure for the `currency` section of the protocol.
#
# Reads one JSON object on stdin, writes one JSON object on stdout. Touchstone knows nothing
# about what is in here; it spawns this file, hands it a subject, and records the badge, the
# rows and the summary that come back. Everything about container registries lives in this
# file, on the volume, so changing where versions are read from is an edit rather than a
# release. See `currency.md` for the policy this reads and for what the numbers mean.
#
#   in : {subject, origin, section, subject_ref, repo, ref, apps_path, compose, policy{…}}
#   out: {status, badge, badge_state, summary, columns[], rows[]}   — or {status:"blocked",…}
#
# Requires: sh, curl, jq. Anything unresolvable is reported `unknown`; anything that stops the
# check from happening at all reports `blocked`. Neither is ever reported as "current".

set -u

TMP=$(mktemp -d "${TMPDIR:-/tmp}/currency.XXXXXX") || { printf '{"status":"blocked","reason":"no writable temp directory"}\n'; exit 0; }
trap 'rm -rf "$TMP"' EXIT INT TERM

blocked() {
  # `jq -n` would be tidier, but this has to work when jq is the thing that is missing.
  printf '{"status":"blocked","reason":"%s"}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  exit 0
}

command -v curl >/dev/null 2>&1 || blocked "curl is not installed in this image, so no registry can be read"
command -v jq   >/dev/null 2>&1 || blocked "jq is not installed in this image, so no registry answer can be parsed"

IN=$(cat)
[ -n "$IN" ] || blocked "nothing arrived on stdin"

j() { printf '%s' "$IN" | jq -r "$1"; }

SUBJECT=$(j '.subject // ""')
REPO=$(j '.repo // "Yundera/AppStore"')
REF=$(j '.ref // "main"')
APPS=$(j '.apps_path // "Apps"')
COMPOSE=$(j '.compose // ""')

POLICY=$(printf '%s' "$IN" | jq -c '.policy // {}')
p() { printf '%s' "$POLICY" | jq -r "$1"; }
STALE_DAYS=$(p '.stale_days // 180')
COMPARE_MAJORS=$(p 'if .compare_majors then "true" else "false" end')
MAX_PAGES=$(p '.max_pages // 10')
TIMEOUT=$(p '.timeout // 20')
PLATFORM=$(printf '%s' "$POLICY" | jq -c '.platform_images // []')

get() { curl -sfL --max-time "$TIMEOUT" "$@" 2>/dev/null; }

# ── the subject's compose ──────────────────────────────────────────────────────────────────
# Handed over when Touchstone already holds the bytes (an upload trial audits files that are
# on no branch); fetched from the store otherwise. Fetching here rather than in the app is
# what keeps Touchstone from needing to know how a store serves a file.
if [ -z "$COMPOSE" ]; then
  RAW="https://raw.githubusercontent.com/$REPO/$REF/$APPS/$SUBJECT/docker-compose.yml"
  COMPOSE=$(get "$RAW")
  [ -n "$COMPOSE" ] || blocked "could not read $APPS/$SUBJECT/docker-compose.yml from $REPO@$REF"
fi

# ── service → image ────────────────────────────────────────────────────────────────────────
# A regex over `image:` lines, tracking the service key above each one. Not a YAML parser:
# the app already has one and this is a shell script, and across all 71 apps of the Yundera
# store this reads every image correctly. A line it cannot attribute to a service still
# produces a row — with an empty service name rather than a dropped image.
printf '%s\n' "$COMPOSE" | awk '
  BEGIN { svc_indent = -1 }
  /^[Ss]ervices:[ \t]*$/ { in_s = 1; next }
  in_s && /^[^ \t#]/     { in_s = 0 }
  in_s && /^[ \t]+[A-Za-z0-9_.-]+:[ \t]*(#.*)?$/ {
    # A service key is one level in — but "one level" is 2 spaces in most of the store and 4
    # in some of it, so the depth is learnt from the first key under `services:` rather than
    # assumed. Without this, `environment:` at the same depth as a service reads as one, and
    # the row is attributed to a block instead of to a container.
    n = match($0, /[^ \t]/) - 1
    if (svc_indent < 0) svc_indent = n
    if (n == svc_indent) { svc = $0; sub(/^[ \t]+/, "", svc); sub(/:.*$/, "", svc) }
  }
  /^[ \t]+image:[ \t]*/ {
    img = $0
    sub(/^[ \t]+image:[ \t]*/, "", img)
    sub(/[ \t]+#.*$/, "", img)
    gsub(/["'"'"']/, "", img)
    sub(/[ \t]+$/, "", img)
    if (img != "" && img !~ /\$\{/) print svc "\t" img
  }
' > "$TMP/images"

[ -s "$TMP/images" ] || blocked "no image was found in $SUBJECT's compose file"

# ── comparison ─────────────────────────────────────────────────────────────────────────────
# The whole of it, in jq, because jq compares arrays element-wise: [1,10] > [1,9] is true
# where the string "1.10" < "1.9". That one property is why this is not a shell loop.
COMPARE='
# Three tag grammars, most specific first. Everything else is refused rather than guessed.
#
#   version-v2.3.0.4_stable_2026-07-09   linuxserver — the release is the part before the `_`
#   stable-3111                          a monotonic counter; `stable-` is its family
#   1.2.3 / v1.2.3 / 1.2.3-alpine        the ordinary case, 76% of the Yundera store
#
# `series` is the fourth outcome and is not a version: `postgres:17`, `redis:8-alpine` and
# `nginx:1.27-alpine` name a line, not a release, so what the pin resolves to moves under it.
# Reporting one as `current` would be true of the tag and misleading about the app.
def parse:
  . as $t
  | first(
      ( $t | capture("^version-v?(?<num>[0-9]+(\\.[0-9]+)*)")
            | { ver: (.num | split(".") | map(tonumber)), suf: "", kind: "release" } ),
      ( $t | capture("^(?<pre>[A-Za-z][A-Za-z0-9]*)-(?<n>[0-9]+)$")
            | { ver: [(.n | tonumber)], suf: ("#" + .pre), kind: "counter" } ),
      ( $t | capture("^v?(?<num>[0-9]+(\\.[0-9]+)*)(?<var>.*)$")
            | (.num | split(".") | map(tonumber)) as $v
            | { ver: $v, suf: .var, kind: (if ($v | length) >= 3 then "release" else "series" end) } )
    ) // null;
($pinned | parse) as $p
| if $p == null then { kind: null, behind: null }
  elif $p.kind == "series" then { kind: "series", behind: null }
  else
    [ .[]
      | . as $t
      | ($t.name | parse) as $q
      | select($q != null)
      | select($q.kind == $p.kind)
      | select($q.suf == $p.suf)
      | select(($q.ver | length) == ($p.ver | length))
      # A supported branch is a decision, not neglect: `postgres:16.13` is one patch behind
      # 16.14, not fourteen releases behind 18.6. A counter has no major to stay inside.
      | select($majors or $p.kind == "counter" or ($q.ver[0] == $p.ver[0]))
      | select($q.ver > $p.ver)
      | { name: $t.name, date: $t.date, ver: $q.ver }
    ]
    | sort_by(.ver)
    | { kind: $p.kind,
        behind: length,
        latest: (last | if . == null then null else .name end),
        superseded_by: (first | if . == null then null else .name end),
        superseded_at: (first | if . == null then null else .date end) }
  end
'

# ── registries ─────────────────────────────────────────────────────────────────────────────

hub_tags() { # $1 repo — Docker Hub, which is the only one that gives a date per tag for free
  _url="https://hub.docker.com/v2/repositories/$1/tags?page_size=100&ordering=last_updated"
  _n=0
  : > "$TMP/tags.jsonl"
  while [ -n "$_url" ] && [ "$_n" -lt "$MAX_PAGES" ]; do
    _body=$(get "$_url") || return 1
    [ -n "$_body" ] || return 1
    printf '%s' "$_body" \
      | jq -c '.results[]? | { name: .name, date: ((.tag_last_pushed // .last_updated // "") | sub("\\.[0-9]+";"")) }' \
      >> "$TMP/tags.jsonl" || return 1
    # Ordered newest-first, so once we have walked past the pinned tag's own date every tag
    # that could be newer than it has been seen. Without this a very old pin reports the
    # earliest of the *recent* releases as the one that superseded it — off by years.
    _pd=$(jq -r --arg t "$2" 'select(.name == $t) | .date' < "$TMP/tags.jsonl" | head -n1)
    if [ -n "$_pd" ]; then
      _last=$(tail -n1 "$TMP/tags.jsonl" | jq -r '.date')
      [ "$_last" \< "$_pd" ] && break
    fi
    _url=$(printf '%s' "$_body" | jq -r '.next // empty')
    _n=$((_n + 1))
  done
  jq -s -c '.' < "$TMP/tags.jsonl"
}

ghcr_tags() { # $1 repo — tags are free, dates are not: fetched later for the one that matters
  _tok=$(get "https://ghcr.io/token?scope=repository:$1:pull&service=ghcr.io" | jq -r '.token // empty')
  [ -n "$_tok" ] || return 1
  # The OCI tag list comes back in registry order — oldest first, in practice — and one page
  # of it is therefore the *wrong* end of the list. Walking the `Link: rel="next"` chain is
  # not optional: a repository with more tags than we read would answer "no newer tag exists"
  # having never looked at the newest ones, which is the one lie this check must not tell.
  # When the chain outlives `max_pages` we say so, and the caller refuses to report `current`.
  _url="https://ghcr.io/v2/$1/tags/list?n=1000"
  _n=0
  : > "$TMP/ghcr.jsonl"
  while [ -n "$_url" ] && [ "$_n" -lt "$MAX_PAGES" ]; do
    _body=$(curl -sfL --max-time "$TIMEOUT" -D "$TMP/hdr" -H "Authorization: Bearer $_tok" "$_url" 2>/dev/null) || return 1
    printf '%s' "$_body" | jq -c '.tags[]? | { name: ., date: null }' >> "$TMP/ghcr.jsonl" || return 1
    _link=$(tr -d '\r' < "$TMP/hdr" | sed -n 's/^[Ll]ink:.*<\([^>]*\)>.*rel="next".*/\1/p' | head -n1)
    case "$_link" in
      '') _url="" ;;
      /*) _url="https://ghcr.io$_link" ;;
      *)  _url="$_link" ;;
    esac
    _n=$((_n + 1))
  done
  # A function's assignments die with the subshell that `$( )` puts it in, so the flag is a
  # file rather than a variable.
  [ -n "$_url" ] && : > "$TMP/truncated"
  jq -s -c '.' < "$TMP/ghcr.jsonl"
}

ghcr_date() { # $1 repo  $2 tag — manifest → config blob → `created`
  _tok=$(get "https://ghcr.io/token?scope=repository:$1:pull&service=ghcr.io" | jq -r '.token // empty')
  [ -n "$_tok" ] || return 1
  _acc='application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'
  _m=$(get -H "Authorization: Bearer $_tok" -H "Accept: $_acc" "https://ghcr.io/v2/$1/manifests/$2")
  [ -n "$_m" ] || return 1
  # A multi-arch index names no config of its own; follow its first child.
  _child=$(printf '%s' "$_m" | jq -r '.manifests[0].digest // empty')
  if [ -n "$_child" ]; then
    _m=$(get -H "Authorization: Bearer $_tok" -H "Accept: $_acc" "https://ghcr.io/v2/$1/manifests/$_child")
  fi
  _cfg=$(printf '%s' "$_m" | jq -r '.config.digest // empty')
  [ -n "$_cfg" ] || return 1
  get -H "Authorization: Bearer $_tok" "https://ghcr.io/v2/$1/blobs/$_cfg" \
    | jq -r '(.created // "") | sub("\\.[0-9]+";"")'
}

quay_tags() { # $1 repo — `start_ts` is an epoch, which sidesteps parsing an RFC 2822 date in sh
  get "https://quay.io/api/v1/repository/$1/tag/?limit=100&onlyActiveTags=true" \
    | jq -c '[ .tags[]? | { name: .name, date: (.start_ts | todate) } ]'
}

# ── one row per image ──────────────────────────────────────────────────────────────────────
: > "$TMP/rows.jsonl"
UNREACHABLE=0
RESOLVED=0

while IFS='	' read -r SVC IMG; do
  [ -n "$IMG" ] || continue

  STATE=unknown; NOTE=""; PINNED=""; LATEST=""; BEHIND=""; SINCE=""; SOURCE=""

  # Split `host/path:tag@digest`. The first segment is a registry only if it looks like a
  # hostname; `filebrowser/filebrowser` is a Docker Hub namespace, not a host.
  NAME=${IMG%%@*}
  DIGEST=""
  case "$IMG" in *@sha256:*) DIGEST=${IMG#*@} ;; esac

  case "$NAME" in
    */*) FIRST=${NAME%%/*} ;;
    *)   FIRST="" ;;
  esac
  case "$FIRST" in
    *.*|*:*|localhost) HOST=$FIRST; PATHPART=${NAME#*/} ;;
    *)                 HOST="docker.io"; PATHPART=$NAME ;;
  esac

  # `lscr.io/linuxserver/x` is GHCR wearing a different hostname.
  [ "$HOST" = "lscr.io" ] && HOST="ghcr.io"

  case "$PATHPART" in
    */*:*) PINNED=${PATHPART##*:}; REPOPATH=${PATHPART%:*} ;;
    *:*)   PINNED=${PATHPART##*:}; REPOPATH=${PATHPART%:*} ;;
    *)     PINNED=""; REPOPATH=$PATHPART ;;
  esac
  # Docker Hub's official images live under `library/`.
  if [ "$HOST" = "docker.io" ]; then
    case "$REPOPATH" in */*) : ;; *) REPOPATH="library/$REPOPATH" ;; esac
  fi

  # How the image is written in the compose file, near enough: an official Docker Hub image
  # is `nginx`, not `docker.io/library/nginx`, and a row nobody recognises is a row nobody
  # checks against their own file.
  DISPLAY="$HOST/$REPOPATH"
  if [ "$HOST" = "docker.io" ]; then
    case "$REPOPATH" in library/*) DISPLAY=${REPOPATH#library/} ;; *) DISPLAY=$REPOPATH ;; esac
  fi

  IS_PLATFORM=$(printf '%s' "$PLATFORM" | jq -r --arg i "$DISPLAY" --arg h "$HOST/$REPOPATH" \
    'if any(.[]; . == $i or . == $h) then "yes" else "" end')

  if [ -n "$DIGEST" ]; then
    STATE=unknown; NOTE="pinned by digest — nothing to compare"; PINNED="@${DIGEST#sha256:}"
    PINNED=$(printf '%s' "$PINNED" | cut -c1-12)
  elif [ -z "$PINNED" ] || [ "$PINNED" = "latest" ]; then
    STATE=floating; NOTE="the tag is a moving target, so there is no version to be behind"
    [ -z "$PINNED" ] && PINNED="latest"
  else
    case "$PINNED" in
      *[0-9]*) : ;;
      *) STATE=floating; NOTE="the tag carries no number at all, so it moves under the pin" ;;
    esac
  fi

  if [ "$STATE" = "unknown" ] && [ -z "$NOTE" ]; then
    TAGS=""
    rm -f "$TMP/truncated"
    case "$HOST" in
      docker.io) TAGS=$(hub_tags "$REPOPATH" "$PINNED"); SOURCE="dockerhub" ;;
      ghcr.io)   TAGS=$(ghcr_tags "$REPOPATH");          SOURCE="ghcr" ;;
      quay.io)   TAGS=$(quay_tags "$REPOPATH");          SOURCE="quay" ;;
      *)         NOTE="$HOST is not a registry this check can read"; SOURCE="$HOST" ;;
    esac

    if [ -n "$NOTE" ]; then
      : # an unsupported registry: already explained, and not an outage
    elif [ -z "$TAGS" ] || [ "$TAGS" = "null" ] || [ "$TAGS" = "[]" ]; then
      UNREACHABLE=$((UNREACHABLE + 1))
      NOTE="$SOURCE did not answer with a tag list"
    else
      RESULT=$(printf '%s' "$TAGS" | jq -c --arg pinned "$PINNED" --argjson majors "$COMPARE_MAJORS" "$COMPARE")
      BEHIND=$(printf '%s' "$RESULT" | jq -r '.behind // "" | tostring')
      KIND=$(printf '%s' "$RESULT" | jq -r '.kind // ""')
      if [ "$KIND" = "series" ]; then
        STATE=floating
        NOTE="\`$PINNED\` names a release line rather than a release, so it moves under the pin"
      elif [ -z "$BEHIND" ] || [ "$BEHIND" = "null" ]; then
        NOTE="\`$PINNED\` is not a version this check knows how to order"
      else
        RESOLVED=$((RESOLVED + 1))
        LATEST=$(printf '%s' "$RESULT" | jq -r '.latest // ""')
        SINCE=$(printf '%s' "$RESULT" | jq -r '.superseded_at // ""')
        SUPBY=$(printf '%s' "$RESULT" | jq -r '.superseded_by // ""')
        if [ "$BEHIND" = "0" ] && [ -f "$TMP/truncated" ]; then
          # Nothing newer was found, but we did not see the whole list. Finding a newer tag
          # is positive evidence and survives truncation; finding none is only as good as
          # how much we read, so this stays `unknown` rather than becoming a green cell.
          STATE=unknown; BEHIND=""
          NOTE="$SOURCE has more tags than this check reads, so newer ones may exist"
        elif [ "$BEHIND" = "0" ]; then
          STATE=current; LATEST="$PINNED"
        else
          STATE=behind
          # GHCR hands over no dates with its tag list, so the one date that matters — when
          # the app first fell behind — is fetched for that single tag rather than for all
          # thousand. Two extra requests per image, not per tag.
          if [ -z "$SINCE" ] && [ "$SOURCE" = "ghcr" ] && [ -n "$SUPBY" ]; then
            SINCE=$(ghcr_date "$REPOPATH" "$SUPBY" || true)
          fi
        fi
      fi
    fi
  fi

  jq -n -c \
    --arg service "$SVC" --arg image "$DISPLAY" --arg pinned "$PINNED" \
    --arg latest "$LATEST" --arg behind "$BEHIND" --arg since "$SINCE" \
    --arg state "$STATE" --arg note "$NOTE" --arg source "$SOURCE" --arg platform "$IS_PLATFORM" \
    --argjson stale "$STALE_DAYS" '
      (if $since == "" then null else ($since | try fromdateiso8601 catch null) end) as $t
      | (if $t == null then null else (((now - $t) / 86400) | floor) end) as $days
      | { service: (if $service == "" then "—" else $service end),
          image: $image,
          pinned: $pinned,
          latest: (if $latest == "" then null else $latest end),
          behind: (if $behind == "" then null else ($behind | tonumber) end),
          stale_since: (if $since == "" then null else $since end),
          days: $days,
          state: (if $state == "behind" and $days != null and $days >= $stale then "stale" else $state end),
          platform: ($platform == "yes"),
          source: (if $source == "" then null else $source end),
          note: (if $note == "" then null else $note end) }' >> "$TMP/rows.jsonl"
done < "$TMP/images"

# ── the reading ────────────────────────────────────────────────────────────────────────────
# Every image was unreadable and at least one of them failed rather than being unsupported:
# that is an outage, not a finding, and the section records blocked. Reporting "current"
# because nothing answered is the one failure mode this whole check must not have.
if [ "$RESOLVED" = "0" ] && [ "$UNREACHABLE" -gt 0 ]; then
  blocked "no registry answered — $UNREACHABLE of the images could not be read"
fi

jq -s -c --argjson stale "$STALE_DAYS" '
  . as $rows
  # The badge speaks for the app, so platform sidecars are counted and shown but do not
  # colour it: an old AppShield is the operator'"'"'s to fix, not the app author'"'"'s.
  | [ $rows[] | select(.platform | not) ] as $own
  | ([ $own[] | select(.state == "stale") ] | length) as $bad
  | ([ $own[] | select(.state == "behind") ] | length) as $warn
  | ([ $own[] | select(.state == "current") ] | length) as $ok
  | ([ $own[] | select(.state == "unknown" or .state == "floating") ] | length) as $unk
  | ([ $own[] | select(.days != null) | .days ] | max) as $worst
  | (if $bad + $warn > 0 then "\($bad + $warn) behind · \($worst)d"
     elif $ok > 0 and $unk > 0 then "current · \($unk)?"
     elif $ok > 0 then "current"
     else "unknown" end) as $badge
  | (if $bad > 0 then "bad" elif $warn > 0 then "warn" elif $ok > 0 then "ok" else "unknown" end) as $state
  | (if $bad + $warn > 0
     then "\($bad + $warn) of \($own | length) images are behind their upstream; the oldest gap opened \($worst) days ago."
     elif $ok > 0 and $unk > 0
     then "Every image this check could read is current; \($unk) could not be compared."
     elif $ok > 0 then "Every image is on the newest release of its own line."
     else "No image in this app could be compared against its registry." end) as $summary
  | { status: "done",
      badge: $badge,
      badge_state: $state,
      summary: $summary,
      columns: [ { key: "service", label: "Service" },
                 { key: "image", label: "Image" },
                 { key: "pinned", label: "Pinned" },
                 { key: "latest", label: "Latest" },
                 { key: "behind", label: "Behind", align: "right" },
                 # The absolute moment the app fell behind, drawn as an age. `days` is in the
                 # row too and is what it was when the reading was taken; this is what keeps
                 # the number on screen true between assays, which is why this check needs no
                 # schedule of its own.
                 { key: "stale_since", label: "Behind for", align: "right", kind: "since" },
                 { key: "note", label: "Note" } ],
      rows: $rows }
' < "$TMP/rows.jsonl"
