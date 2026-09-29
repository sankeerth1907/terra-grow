"""
TerraGrow backend — geospatial land-cover analysis API.
Classes: farmland, barren, city/urban, water -> percentages.

Run:  pip install -r requirements.txt
      python app.py            -> http://127.0.0.1:5000
Frontend: open index.html (or python -m http.server 8000), tick "Use Python backend".

Plug your trained model:
  1. Drop model.onnx (or model.h5 / model.pt) next to this file.
  2. Set USE_TRAINED_MODEL = True and implement run_trained_model() below.
  3. It must return a per-pixel class map with values 0=farm,1=barren,2=city,3=water.
  The API response format stays identical, so the frontend needs no change.
"""
import base64, io, os
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from PIL import Image
import numpy as np

USE_TRAINED_MODEL = False
MODEL_PATH = "model.onnx"   # or model.h5 / model.pt
CLASS_NAMES = ["farm", "barren", "city", "water"]
COLORS = {"farm": (46,158,79), "barren": (201,160,106), "city": (154,160,166), "water": (45,156,219)}

app = Flask(__name__)
CORS(app)

# ---------- Trained-model hook (optional) ----------
_model = None
def run_trained_model(img_rgb: np.ndarray) -> np.ndarray | None:
    """Return HxW array of class ids 0..3, or None to fall back to heuristic.
    Implement ONNX / TF / torch inference here. Example (onnxruntime):
        import onnxruntime as ort
        global _model
        if _model is None: _model = ort.InferenceSession(MODEL_PATH)
        inp = preprocess(img_rgb)  # resize/normalize per your training
        pred = _model.run(None, {"input": inp})[0]  # HxWx4 logits
        return pred.argmax(-1)
    """
    if not USE_TRAINED_MODEL or not os.path.exists(MODEL_PATH):
        return None
    # TODO: add your inference code
    return None

# ---------- Heuristic classifier (mirrors analyzer.js) ----------
def classify_pixels(arr: np.ndarray) -> np.ndarray:
    """arr: HxWx3 uint8 RGB -> HxW uint8 ids (0 farm,1 barren,2 city,3 water)."""
    r = arr[:,:,0].astype(np.int16); g = arr[:,:,1].astype(np.int16); b = arr[:,:,2].astype(np.int16)
    mx = np.maximum(np.maximum(r,g),b); mn = np.minimum(np.minimum(r,g),b); sat = mx-mn
    out = np.ones_like(r, dtype=np.uint8) * 1  # default barren

    water = ((b>50)&(b>=r+12)&(b>=g-18)&(g>=r-10)) | ((b>70)&(g>70)&(r<70)&(b>r+20))
    city_bright = (mx>185)&(sat<32)
    city_gray = (mx<170)&(sat<22)&(mx>60)
    farm = ((g>60)&(g>=r+12)&(g>=b-8)) | ((g>70)&(g>r)&(g>=b)&(sat>12))
    roof_red = (r>140)&(r>g+35)&(sat>45)

    out[water] = 3
    out[city_bright | city_gray] = 2
    # farm overrides gray only where clearly green
    out[farm & ~water] = 0
    out[roof_red & ~farm & ~water] = 2
    return out

def verdict(p):
    top = max(p, key=p.get)
    names = {"farm":"Farmland","barren":"Barren land","city":"City / Urban","water":"Water"}
    t = f"Dominant: {names[top]} ({p[top]}%). "
    if p["farm"]>40: t += "Good cultivation potential. "
    if p["barren"]>40: t += "Large barren patch — consider reclamation / irrigation survey. "
    if p["barren"]>=10: t += f"~{p['barren']}% is barren and potentially reclaimable for crops. "
    if p["city"]>40: t += "Highly urbanized — limited farming scope. "
    if p["water"]>25: t += "Significant water body — check irrigation / drainage. "
    if p["farm"]>=30 and 5<=p["water"]<=30: t += "Farm + water combo ideal for agriculture."
    return t

def water_status(w):
    w = float(w)
    return "deficit" if w < 5 else ("ideal" if w <= 30 else "excess")

def cultivation_score(p):
    s = (p["farm"] + min(p["water"], 15) * 0.6 - max(0, 5 - p["water"]) * 2
         - max(0, p["water"] - 30) * 0.6 - p["city"] * 0.1)
    return round(max(0, min(100, s)), 1)

def area_details(pct, orig_w, orig_h, gsd_m):
    """Mirror of geo.js detailsFor (minus px passthrough)."""
    total_ha = round(orig_w * orig_h * gsd_m * gsd_m / 10000, 2) if orig_w > 0 and orig_h > 0 and gsd_m > 0 else 0.0
    per_ha = {k: round(total_ha * pct[k] / 100, 2) for k in CLASS_NAMES}
    under_ha = per_ha["barren"]
    ws = water_status(pct["water"])
    advice = f"Underutilised (reclaimable barren): {pct['barren']}% (~{under_ha} ha). "
    if ws == "deficit": advice += "Water deficit (<5%) — yield limited by irrigation. "
    elif ws == "excess": advice += "Water excess (>30%) — check drainage before sowing. "
    else: advice += "Water share ideal (5-30%) for most crops. "
    return {"total_ha": total_ha, "per_class_ha": per_ha,
            "under_pct": pct["barren"], "under_ha": under_ha,
            "cultivation_score": cultivation_score(pct), "water_status": ws, "advice": advice}

def analyze_pil(img: Image.Image, max_side=1024, gsd_m=0.0):
    img = img.convert("RGB")
    orig_w, orig_h = img.size
    s = min(1.0, max_side / max(img.size))
    if s < 1: img = img.resize((round(img.width*s), round(img.height*s)), Image.BILINEAR)
    arr = np.array(img)
    cls = run_trained_model(arr)
    engine = "trained-model" if cls is not None else "heuristic-v1"
    if cls is None:
        cls = classify_pixels(arr)
    total = int(cls.size)
    counts = {n: int((cls==i).sum()) for i,n in enumerate(CLASS_NAMES)}
    pct = {k: round(v/total*100, 2) for k,v in counts.items()}
    # overlay mask
    overlay = np.zeros_like(arr)
    for i,n in enumerate(CLASS_NAMES):
        overlay[cls==i] = COLORS[n]
    blend = (arr.astype(float)*0.35 + overlay.astype(float)*0.65).astype(np.uint8)
    buf = io.BytesIO(); Image.fromarray(blend).save(buf, format="PNG")
    mask_b64 = base64.b64encode(buf.getvalue()).decode()
    return {"counts":counts,"percentages":pct,"total_pixels":total,
            "width":orig_w,"height":orig_h,"engine":engine,
            "mask_png_base64":mask_b64,"verdict":verdict(pct),
            "gsd_mpx":gsd_m,"area":area_details(pct, orig_w, orig_h, gsd_m)}

@app.post("/api/analyze")
def api_analyze():
    if "image" not in request.files:
        return jsonify({"error":"send multipart form with field 'image'"}), 400
    try:
        img = Image.open(request.files["image"].stream)
    except Exception as e:
        return jsonify({"error":f"bad image: {e}"}), 400
    out = analyze_pil(img, gsd_m=float(request.form.get("gsd_mpx", 0) or 0))
    out["filename"] = request.files["image"].filename
    return jsonify(out)

@app.post("/api/analyze-batch")
def api_batch():
    files = request.files.getlist("images") or request.files.getlist("image")
    if not files: return jsonify({"error":"send field 'images' (multiple)"}), 400
    results, agg = [], {k:0 for k in CLASS_NAMES}
    tot = 0
    gsd_m = float(request.form.get("gsd_mpx", 0) or 0)
    for f in files:
        try:
            o = analyze_pil(Image.open(f.stream), gsd_m=gsd_m); o["filename"]=f.filename
            for k in agg: agg[k]+=o["counts"][k]
            tot+=o["total_pixels"]; results.append(o)
        except Exception as e:
            results.append({"filename":f.filename,"error":str(e)})
    pct = {k: round(agg[k]/tot*100,2) if tot else 0 for k in agg}
    return jsonify({"results":results,"aggregate":{"counts":agg,"percentages":pct,"total_pixels":tot}})

@app.get("/")
def root():
    return send_from_directory(".", "index.html")

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
