# Python on Skiff Functions

A Python Worker (D121) running on the same pinned workerd as JavaScript functions, with Pyodide
loaded from the node's warmed cache.

```sh
uv tool install workers-py      # provides pywrangler
skif deploy                     # runs `uv run pywrangler sync`, then ships src/ and python_modules/
```

- `main` ending in `.py` is what makes this a Python Worker. Every `.py` file next to it ships too.
- Dependencies in `pyproject.toml` are vendored into `python_modules/` by `pywrangler sync`; keep
  the total under 512 files.
- Functions default to 384 MB for Python (Pyodide is ~230 MB resident); set `"skiff": { "memoryMb": … }`
  in `wrangler.jsonc` to change it (at least 256).
- `wrangler dev` / `uv run pywrangler dev` is the local loop.
- The node needs the Pyodide cache (installed by default; `sudo bun scripts/install/pyodide.ts` on an
  older node). The deploy says so if it is missing.
