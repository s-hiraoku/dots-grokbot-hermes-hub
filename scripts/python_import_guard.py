"""Import guard for an explicitly reviewed, fixed-input local pilot.

Not a general Python sandbox. Install before third-party imports under a sanitized
launcher, pin this module and the wrapper, and independently measure every root.
"""
import os
import sys
from pathlib import Path


def install_guard(roots, excluded, native_files=()):
    approved = tuple(Path(p).resolve() for p in roots)
    blocked = tuple(Path(p).resolve() for p in excluded)
    natives = tuple(Path(p).resolve() for p in native_files)

    def below(path, bases):
        p = Path(path).resolve()
        return any(p == root or root in p.parents for root in bases)

    def allowed(path):
        return not below(path, blocked) and below(path, approved)

    def check_spec(spec):
        if spec is None:
            return
        if spec.origin not in (None, "built-in", "frozen") and not allowed(spec.origin):
            raise ImportError("pilot_import_origin_rejected")
        for path in spec.submodule_search_locations or ():
            if not allowed(path):
                raise ImportError("pilot_package_path_rejected")

    class Finder:
        def __init__(self, delegate):
            self.delegate = delegate

        def find_spec(self, fullname, path=None, target=None):
            method = getattr(self.delegate, "find_spec", None)
            if method is None:
                raise ImportError("pilot_legacy_finder_rejected")
            spec = method(fullname, path, target)
            check_spec(spec)
            return spec

    finders = tuple(Finder(finder) for finder in sys.meta_path)
    sys.meta_path[:] = finders
    sys.path[:] = [p for p in sys.path if p and allowed(p)]

    def audit(event, args):
        if event in ("open", "os.listdir", "os.scandir") and args:
            path = args[0]
            if isinstance(path, (str, bytes, os.PathLike)) and below(os.fsdecode(path), blocked):
                raise PermissionError("pilot_excluded_read_rejected")
        if event == "ctypes.dlopen" and args and args[0] is not None:
            path = os.fsdecode(args[0])
            canonical = Path(path).resolve()
            if not os.path.isabs(path) or below(canonical, blocked) or (
                not str(canonical).startswith(("/System/Library/", "/usr/lib/"))
                and not (allowed(canonical) or canonical in natives)
            ):
                raise PermissionError("pilot_native_load_rejected")

    sys.addaudithook(audit)

    def assert_loaded():
        if tuple(sys.meta_path) != finders:
            raise RuntimeError("pilot_finder_changed")
        if any(not p or not allowed(p) for p in sys.path):
            raise RuntimeError("pilot_search_path_rejected")
        for module in tuple(sys.modules.values()):
            path = getattr(module, "__file__", None)
            if path and not path.startswith("<") and not allowed(path):
                raise RuntimeError("pilot_loaded_origin_rejected")
            for path in getattr(module, "__path__", ()):
                if not allowed(path):
                    raise RuntimeError("pilot_loaded_package_rejected")
        return allowed

    return assert_loaded
