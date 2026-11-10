#!/usr/bin/env python3
"""
Mesa 24.0 removed dri.pc (classic DRI drivers were dropped). Xwayland 24.1.x
has a hard dependency on it in include/meson.build. Make dri optional and fall
back to libdrm's include path, which carries the same DRI headers.
"""
import sys
import pathlib

p = pathlib.Path(sys.argv[1])
t = p.read_text()

old = (
    "dri_dep = dependency('dri', required : true)\n"
    "dri_inc = include_directories(dri_dep.get_variable(pkgconfig : 'dridriverdir', default_value: ''))"
)

new = (
    "dri_dep = dependency('dri', required : false)\n"
    "if dri_dep.found()\n"
    "    dri_inc = include_directories(dri_dep.get_variable(pkgconfig : 'dridriverdir', default_value: ''))\n"
    "else\n"
    "    libdrm_dep = dependency('libdrm', required : true)\n"
    "    dri_inc = include_directories(libdrm_dep.get_variable(pkgconfig : 'includedir', default_value: '/usr/include'))\n"
    "endif"
)

if old not in t:
    print(f"WARNING: expected dri pattern not found in {p}, file may already be patched or has changed", file=sys.stderr)
    sys.exit(0)

p.write_text(t.replace(old, new, 1))
print(f"Patched {p}")
