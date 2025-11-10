import os
import json
import time

CACHE_DIR = os.path.join(os.path.dirname(__file__), "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

def load_cache(name, max_age_seconds=None):
    path = os.path.join(CACHE_DIR, name)
    if os.path.exists(path):
        if max_age_seconds is not None:
            try:
                age_seconds = time.time() - os.path.getmtime(path)
                if age_seconds > max_age_seconds:
                    return None
            except OSError:
                return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None
    return None

def save_cache(name, data):
    path = os.path.join(CACHE_DIR, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
