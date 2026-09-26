# TerraGrow — Geo-Spatial Land Analysis

Upload satellite / drone images → get **% Farmland / % Barren / % City / % Water** + segmented overlay mask.

![classes](tile_r04_c04.png)

## Quick start (frontend only — no install)

1. Serve the folder (browsers block `fetch()` of sample tiles on `file://`):
   ```
   python -m http.server 8000
   ```
2. Open http://localhost:8000 → **Upload Images** → **Analyze all**.
3. Or click **Load sample tiles** to test with the bundled `tile_*.png` mosaic.

## Full stack (Python backend)

```
pip install -r requirements.txt
python app.py
```
- API: `POST http://127.0.0.1:5000/api/analyze` (form field `image`) → `{ counts, percentages, mask_png_base64, verdict, engine }`
- Batch: `POST /api/analyze-batch` (field `images`, multiple)
- In the site, tick **Use Python backend if running** → Analyze.

Test:
```
curl -F "image=@tile_r04_c04.png" http://127.0.0.1:5000/api/analyze
```

## Plug your trained model

1. Drop `model.onnx` / `model.h5` / `model.pt` next to `app.py`.
2. Set `USE_TRAINED_MODEL = True`, implement `run_trained_model()` (must return H×W ids: 0=farm, 1=barren, 2=city, 3=water).
3. Response format is unchanged → frontend works as-is. `engine` field tells you which path ran.

## Files

| File | Role |
|---|---|
| `index.html` / `styles.css` / `analyzer.js` | TerraGrow UI + in-browser classifier (mirrors backend) + farm dashboard (Worker API) |
| `app.py` | Flask API + heuristic fallback + model hook |
| `src/index.js` | Cloudflare Worker: ingest, farms, recommend, monitor, alerts, stats |
| `wrangler.toml` / `schema.sql` | R2 + D1 bindings, cron, vars/secrets, DB schema + crop calendar |
| `tests/` | `phase12` (ingest + core APIs) · `phase3` (model tiers) · `phase5` (alerts) · `load` |
| `tile_*.png` | Sample satellite mosaic tiles |

## Cloudflare full stack (Phases 1–6)

Local run (two terminals):

```
# 1. Worker API with local R2 + D1
npx wrangler dev --local --port 8788   # -> http://127.0.0.1:8788/api/health
# 2. Frontend
python -m http.server 8000             # -> http://localhost:8000
```

In the page, scroll to **Farm dashboard**, press **Test**, then create a farm and use
Imagery / Recommend / Monitor / Alerts. **Save current analysis to cloud** pushes
browser results into the Worker (auto-linked to farm imagery by `r2_key`).

Tests (mocked D1/R2, stub model + webhook servers — no cloud account needed):

```
npm test          # phase12 (9) + phase3 (9) + phase5 (10)
npm run test:load # 30 rapid analyses
```

Deploy:

```
wrangler login
wrangler r2 bucket create terragrow-images
wrangler d1 create terragrow-db            # paste the id into wrangler.toml
npm run db:remote                          # apply schema.sql + crop calendar
npm run deploy                             # Worker -> https://terragrow-api.<you>.workers.dev
npm run pages                              # frontend -> Pages (set Worker URL in dashboard)
```

Optional integrations (all best-effort, pipeline never breaks without them):

```
wrangler secret put MODEL_API_KEY      # Bearer for EXTERNAL_MODEL_URL (Phase 3 GPU model)
wrangler secret put NOTIFY_API_KEY     # Bearer for NOTIFY_WEBHOOK_URL (Phase 5 alerts)
wrangler secret put SENTINEL_HUB_KEY   # satellite provider (Phase 1 cron)
```

API map: `GET /api/health` · `POST /farms` · `GET /farms` · `GET /farms/:id`
`GET /farms/:id/imagery|recommend|monitor|alerts(?unresolved=1)` · `POST /alerts/:id/resolve`
`POST /internal/ingest` · `POST /internal/analyze` (also weekly cron)
`POST /api/analyze` · `POST /api/results` · `GET /api/results|stats` · `GET /api/file/:key`

## How classification works (heuristic fallback)

Per-pixel rules calibrated on the sample tiles: water = blue/teal dominant · city = bright/low-saturation gray-white + red rooftops · farm = green dominant · barren = warm red/brown dominant. Replace with your CV model for production accuracy.
