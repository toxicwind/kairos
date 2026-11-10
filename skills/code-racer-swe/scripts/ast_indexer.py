#!/usr/bin/env python3
"""
High-Speed Dynamic Dual-Pass AST Indexer for Isolated SWE Sandboxes
Combines sub-millisecond regex candidate filtering with exact AST verification.
Extracts all synchronous and asynchronous function and class definitions.
"""
import ast
import os
import json
import sys
import time
import re

SYMBOL_PATTERN = re.compile(r"^\s*(?:async\s+def|def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)", re.MULTILINE)

def index_repository(root_dir="/workspace"):
    start_time = time.time()
    index = {
        "metadata": {
            "root_dir": root_dir,
            "generated_at": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime()),
            "total_files_scanned": 0,
            "total_symbols": 0,
            "async_symbols_count": 0
        },
        "symbols": {},
        "files": {}
    }
    
    for dirpath, _, filenames in os.walk(root_dir):
        if any(part.startswith(".") or part in ["__pycache__", "venv", "env", "build", "dist"] for part in dirpath.split(os.sep)):
            continue
            
        for filename in filenames:
            if not filename.endswith(".py"):
                continue
                
            filepath = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(filepath, root_dir)
            index["metadata"]["total_files_scanned"] += 1
            
            try:
                with open(filepath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
            except Exception:
                continue

            # Pass 1: Quick regex check
            if not SYMBOL_PATTERN.search(content):
                continue
                
            # Pass 2: Precise AST parsing
            try:
                tree = ast.parse(content, filename=rel_path)
            except Exception:
                continue
                
            file_symbols = []
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    is_async = isinstance(node, ast.AsyncFunctionDef)
                    symbol_type = "async_function" if is_async else ("function" if isinstance(node, ast.FunctionDef) else "class")
                    
                    symbol_info = {
                        "name": node.name,
                        "type": symbol_type,
                        "file": rel_path,
                        "line_start": node.lineno,
                        "line_end": getattr(node, "end_lineno", node.lineno),
                        "is_async": is_async
                    }
                    
                    if node.name not in index["symbols"]:
                        index["symbols"][node.name] = []
                    index["symbols"][node.name].append(symbol_info)
                    file_symbols.append(node.name)
                    
                    index["metadata"]["total_symbols"] += 1
                    if is_async:
                        index["metadata"]["async_symbols_count"] += 1
                        
            index["files"][rel_path] = {
                "line_count": len(content.splitlines()),
                "symbols": file_symbols
            }
            
    index["metadata"]["scan_duration_sec"] = round(time.time() - start_time, 3)
    return index

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/workspace"
    out_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(target, ".dynamic_symbols.json")
    
    print(f"[ast_indexer] Scanning repository at {target}...")
    result = index_repository(target)
    
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
        
    print(f"[ast_indexer] Completed in {result['metadata']['scan_duration_sec']}s: "
          f"{result['metadata']['total_files_scanned']} files, "
          f"{result['metadata']['total_symbols']} symbols "
          f"({result['metadata']['async_symbols_count']} async). "
          f"Saved to {out_file}")
