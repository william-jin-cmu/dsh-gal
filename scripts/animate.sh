#!/usr/bin/env bash
# Animate a character sprite into a subtle idle-motion loop via fal.ai.
# Usage: animate.sh <input.png> <output.mp4> "<motion prompt>" [model]
#   model: seedance (default, bytedance/seedance-2.0/mini) | h3 (minimax/h3)
# Auth: FAL_API_KEY from env or ~/Developer/nex-studio/.env
set -euo pipefail

INPUT="$1"; OUTPUT="$2"; PROMPT="$3"; MODEL="${4:-seedance}"

if [[ -z "${FAL_API_KEY:-}" ]]; then
  FAL_API_KEY=$(grep -m1 '^FAL_API_KEY=' ~/Developer/nex-studio/.env | cut -d= -f2-)
fi
[[ -n "$FAL_API_KEY" ]] || { echo "no FAL_API_KEY" >&2; exit 1; }

if [[ "$MODEL" == "h3" ]]; then
  ENDPOINT="minimax/h3/image-to-video"
  BODY_EXTRA='"resolution": "768p", "duration": 6'
else
  ENDPOINT="bytedance/seedance-2.0/mini/image-to-video"
  BODY_EXTRA='"resolution": "720p", "duration": "5", "generate_audio": false'
fi

# 1. upload the image to fal storage
MIME="image/png"
UPLOAD=$(curl -sf -X POST "https://rest.alpha.fal.ai/storage/upload/initiate" \
  -H "Authorization: Key $FAL_API_KEY" -H "Content-Type: application/json" \
  -d "{\"file_name\": \"$(basename "$INPUT")\", \"content_type\": \"$MIME\"}")
UPLOAD_URL=$(echo "$UPLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin)['upload_url'])")
FILE_URL=$(echo "$UPLOAD" | python3 -c "import json,sys; print(json.load(sys.stdin)['file_url'])")
curl -sf -X PUT "$UPLOAD_URL" -H "Content-Type: $MIME" --data-binary "@$INPUT" > /dev/null
echo "uploaded: $FILE_URL" >&2

# 2. queue the generation
SUBMIT=$(python3 -c "import json,sys; d=json.loads(sys.argv[3]); d.update({'prompt': sys.argv[1], 'image_url': sys.argv[2]}); print(json.dumps(d))" "$PROMPT" "$FILE_URL" "{$BODY_EXTRA}")
REQ=$(curl -sf -X POST "https://queue.fal.run/$ENDPOINT" \
  -H "Authorization: Key $FAL_API_KEY" -H "Content-Type: application/json" \
  -d "$SUBMIT")
REQ_ID=$(echo "$REQ" | python3 -c "import json,sys; print(json.load(sys.stdin)['request_id'])")
STATUS_URL=$(echo "$REQ" | python3 -c "import json,sys; print(json.load(sys.stdin)['status_url'])")
RESPONSE_URL=$(echo "$REQ" | python3 -c "import json,sys; print(json.load(sys.stdin)['response_url'])")
echo "queued: $REQ_ID" >&2

# 3. poll
for i in $(seq 1 120); do
  sleep 5
  STATUS=$(curl -sf "$STATUS_URL" -H "Authorization: Key $FAL_API_KEY" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
  echo "  [$i] $STATUS" >&2
  [[ "$STATUS" == "COMPLETED" ]] && break
done
[[ "$STATUS" == "COMPLETED" ]] || { echo "generation did not complete" >&2; exit 1; }

# 4. download
VIDEO_URL=$(curl -sf "$RESPONSE_URL" -H "Authorization: Key $FAL_API_KEY" | python3 -c "import json,sys; print(json.load(sys.stdin)['video']['url'])")
for i in 1 2 3; do
  curl -sf -o "$OUTPUT" "$VIDEO_URL" && ffprobe -v error "$OUTPUT" >/dev/null 2>&1 && break
  echo "download attempt $i failed, retrying" >&2; sleep 3
done
ffprobe -v error "$OUTPUT" >/dev/null 2>&1 || { echo "downloaded file is corrupt" >&2; exit 1; }
echo "saved: $OUTPUT"
