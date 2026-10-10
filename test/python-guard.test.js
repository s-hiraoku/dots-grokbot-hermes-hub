import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import process from "node:process";

test("Python guard prevents excluded code execution, file reads and native loads before admission", () => {
  const code = `
import sys,pathlib,tempfile,importlib.util,sysconfig,ctypes
root=pathlib.Path(tempfile.mkdtemp())
allowed=root/'approved'; allowed.mkdir()
excluded=allowed/'global'; excluded.mkdir()
(excluded/'forbidden.py').write_text("raise RuntimeError('must never execute')")
(allowed/'safe.py').write_text('value=7')
script=pathlib.Path('scripts/python_import_guard.py').resolve()
spec=importlib.util.spec_from_file_location('pilot_guard',script)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
# The reviewed harness itself lies outside the service; remove its cached filename.
sys.modules['__main__'].__file__=str(allowed/'safe.py')
sys.path=[str(allowed),str(excluded),sysconfig.get_path('stdlib'),sysconfig.get_path('platstdlib')+'/lib-dynload']
check=module.install_guard([allowed,sysconfig.get_path('stdlib')],[excluded])
assert importlib.import_module('safe').value==7
sys.path.append(str(excluded))
try:importlib.import_module('forbidden');raise AssertionError('unblocked import')
except ImportError:pass
sys.path.remove(str(excluded))
try:(excluded/'forbidden.py').read_text();raise AssertionError('unblocked read')
except PermissionError:pass
try:ctypes.CDLL(str(excluded/'unmeasured.dylib'));raise AssertionError('unblocked dlopen')
except PermissionError:pass
try:ctypes.CDLL('/usr/lib/../../'+str(excluded/'unmeasured.dylib').lstrip('/'));raise AssertionError('unblocked canonical dlopen')
except PermissionError:pass
check()
print('guard-ok')
`;
  const stdout = execFileSync("/usr/bin/python3", ["-I", "-S", "-c", code], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10000,
    env: { PATH: "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(stdout.trim(), "guard-ok");
});
