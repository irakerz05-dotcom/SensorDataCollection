import argparse
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from app.config import ROOT, load_config
from app.service import VerdeService
from app.web import make_server


def main():
    parser = argparse.ArgumentParser(description="VERDE Software Prototype v0.1 — local development")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--config", help="Path to local JSON configuration")
    parser.add_argument("--web-root", help="Path to the VERDEapp PWA directory")
    parser.add_argument(
        "--trusted-origin",
        help="Exact private HTTPS origin forwarded by Tailscale Serve (for example https://verde.example.ts.net)",
    )
    args = parser.parse_args()
    (ROOT / "logs").mkdir(exist_ok=True)
    handlers = [logging.StreamHandler()]
    try:
        handlers.append(RotatingFileHandler(ROOT / "logs" / "verde.log", maxBytes=1_000_000, backupCount=3, encoding="utf-8"))
    except OSError as exc:
        print(f"File logging unavailable; using console: {exc}")
    logging.basicConfig(level=logging.INFO, handlers=handlers, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = load_config(args.config)
    except (OSError, ValueError, TypeError) as exc:
        parser.error(f"Invalid configuration: {exc}")
    web_root = Path(args.web_root).expanduser().resolve() if args.web_root else None
    if web_root and not (web_root / "index.html").is_file():
        parser.error("--web-root must be a PWA directory containing index.html")
    service = VerdeService(config)
    server = None
    try:
        server = make_server(service, args.port, web_root=web_root, trusted_origin=args.trusted_origin)
        service.start()
        print(f"VERDE v0.1 dashboard: http://127.0.0.1:{server.server_port}", flush=True)
        if args.trusted_origin:
            print(f"Private authenticated PWA origin: {args.trusted_origin}", flush=True)
        print("Development adapters only. Physical outputs unavailable. Ctrl+C to stop.", flush=True)
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    except OSError as exc:
        logging.error("Server could not run: %s", exc)
        raise SystemExit(1)
    finally:
        if server:
            server.server_close()
        service.close()


if __name__ == "__main__":
    main()
