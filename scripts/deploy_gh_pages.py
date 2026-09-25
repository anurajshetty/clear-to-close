#!/usr/bin/env python3
"""Deploy the Realtor App web export (dist/) to the gh-pages branch via the
GitHub git-data API. Replaces the whole branch tree with dist/ contents,
regenerates 404.html from index.html (SPA fallback), and keeps .nojekyll.

Creates the gh-pages branch on first run (the repo starts empty).

Usage: python3 deploy_gh_pages.py
Must run from anywhere; REPO/DIST are constants below.
"""
import base64
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

REPO = "anurajshetty/realtor-app"
BRANCH = "gh-pages"
DIST = os.path.expanduser("~/workspace/realtor-app/dist")
API = "https://api.github.com"
ALLOWED = ("api.github.com",)
CRED = "custom.github"


class ApiError(RuntimeError):
    def __init__(self, code, detail):
        super().__init__(f"HTTP {code}: {detail}")
        self.code = code


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    add_surrogate_to_request(req, CRED, allowed_hosts=ALLOWED)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return read_json_response(resp)
    except urllib.error.HTTPError as exc:  # noqa
        detail = exc.read().decode("utf-8", "replace")[:600]
        raise ApiError(exc.code, f"GitHub API {method} {path} -> {detail}")


def upload_tree(files):
    tree_entries = []
    for i, (rel, raw) in enumerate(sorted(files.items())):
        blob = api("POST", f"/repos/{REPO}/git/blobs",
                   {"content": base64.b64encode(raw).decode(), "encoding": "base64"})
        tree_entries.append({"path": rel, "mode": "100644", "type": "blob",
                             "sha": blob["sha"]})
        if (i + 1) % 25 == 0:
            print(f"  ... {i + 1}/{len(files)}")
    return tree_entries


def main():
    # Collect dist/ files.
    files = {}
    for root, _dirs, names in os.walk(DIST):
        for n in names:
            fpath = os.path.join(root, n)
            rel = os.path.relpath(fpath, DIST)
            with open(fpath, "rb") as f:
                files[rel] = f.read()
    if "index.html" not in files:
        raise RuntimeError(f"no index.html in {DIST} — run the web export first")
    # SPA fallback: 404.html mirrors index.html (regenerated every deploy so
    # it never points at a stale bundle).
    files["404.html"] = files["index.html"]
    # .nojekyll must exist (empty) so Pages serves _expo/ as-is.
    files[".nojekyll"] = b""
    print(f"uploading {len(files)} files")

    try:
        ref = api("GET", f"/repos/{REPO}/git/refs/heads/{BRANCH}")
        remote_sha = ref["object"]["sha"]
        print(f"gh-pages head: {remote_sha[:7]}")

        tree_entries = upload_tree(files)

        # Full-tree replace: list remote blobs and delete any not in dist/.
        tree = api("GET", f"/repos/{REPO}/git/commits/{remote_sha}")["tree"]["sha"]
        old = api("GET", f"/repos/{REPO}/git/trees/{tree}?recursive=1").get("tree", [])
        old_paths = {t["path"] for t in old if t["type"] == "blob"}
        for rel in sorted(old_paths - set(files)):
            tree_entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": None})
            print(f"  D {rel}")

        new_tree = api("POST", f"/repos/{REPO}/git/trees",
                       {"base_tree": tree, "tree": tree_entries})["sha"]
        parents = [remote_sha]
        patch = True
    except ApiError as exc:
        if exc.code != 404:
            raise
        # First deploy: branch does not exist yet — create it.
        print("gh-pages branch does not exist; creating it")
        tree_entries = upload_tree(files)
        new_tree = api("POST", f"/repos/{REPO}/git/trees",
                       {"tree": tree_entries})["sha"]
        parents = []
        patch = False

    commit = api("POST", f"/repos/{REPO}/git/commits",
                 {"message": "Deploy Realtor App web",
                  "tree": new_tree, "parents": parents})
    new_sha = commit["sha"]
    print(f"created commit {new_sha}")

    if patch:
        # NOTE: the ref-update endpoint is /git/refs/ (plural); singular 404s.
        api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": new_sha})
    else:
        api("POST", f"/repos/{REPO}/git/refs",
            {"ref": f"refs/heads/{BRANCH}", "sha": new_sha})
    print(f"updated {BRANCH} -> {new_sha}")

    # Verify the ref actually moved.
    check = api("GET", f"/repos/{REPO}/git/refs/heads/{BRANCH}")
    assert check["object"]["sha"] == new_sha, "ref did not move!"
    print("ref move verified")


if __name__ == "__main__":
    main()
