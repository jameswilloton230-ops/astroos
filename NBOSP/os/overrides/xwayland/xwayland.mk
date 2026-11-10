################################################################################
#
# xwayland
#
################################################################################

XWAYLAND_VERSION = 24.1.6
XWAYLAND_SOURCE = xwayland-$(XWAYLAND_VERSION).tar.xz
XWAYLAND_SITE = https://xorg.freedesktop.org/archive/individual/xserver
XWAYLAND_LICENSE = MIT
XWAYLAND_LICENSE_FILES = COPYING
XWAYLAND_CPE_ID_VENDOR = x.org
XWAYLAND_INSTALL_STAGING = YES
XWAYLAND_DEPENDENCIES = \
	libdrm \
	mesa3d \
	pixman \
	wayland \
	wayland-protocols \
	xlib_libxcvt \
	xlib_libXfont2 \
	xlib_libxkbfile \
	xlib_libXrandr \
	xlib_libxshmfence \
	xlib_xtrans \
	xorgproto
XWAYLAND_CONF_OPTS = \
	-Ddri3=true \
	-Dxvfb=false \
	-Ddefault_font_path=/usr/share/fonts/X11/ \
	-Ddtrace=false \
	-Ddocs=false

ifeq ($(BR2_PACKAGE_LIBEPOXY),y)
XWAYLAND_CONF_OPTS += -Dglamor=true
XWAYLAND_DEPENDENCIES += libepoxy
else
XWAYLAND_CONF_OPTS += -Dglamor=false
endif

ifeq ($(BR2_PACKAGE_HAS_LIBGL),y)
XWAYLAND_CONF_OPTS += -Dglx=true
XWAYLAND_DEPENDENCIES += libgl
else
XWAYLAND_CONF_OPTS += -Dglx=false
endif

ifeq ($(BR2_PACKAGE_XLIB_LIBXDMCP),y)
XWAYLAND_CONF_OPTS += \
	-Dxdmcp=true \
	-Dxdm-auth-1=true
XWAYLAND_DEPENDENCIES += xlib_libXdmcp
else
XWAYLAND_CONF_OPTS += \
	-Dxdmcp=false \
	-Dxdm-auth-1=false
endif

ifeq ($(BR2_PACKAGE_LIBTIRPC),y)
XWAYLAND_CONF_OPTS += -Dsecure-rpc=true
XWAYLAND_DEPENDENCIES += libtirpc
else
XWAYLAND_CONF_OPTS += -Dsecure-rpc=false
endif

XWAYLAND_CONF_OPTS += -Dxselinux=false

ifeq ($(BR2_PACKAGE_OPENSSL),y)
XWAYLAND_CONF_OPTS += -Dsha1=libcrypto
XWAYLAND_DEPENDENCIES += openssl
else ifeq ($(BR2_PACKAGE_LIBGCRYPT),y)
XWAYLAND_CONF_OPTS += -Dsha1=libgcrypt
XWAYLAND_DEPENDENCIES += libgcrypt
else
XWAYLAND_CONF_OPTS += -Dsha1=libsha1
XWAYLAND_DEPENDENCIES += libsha1
endif

ifeq ($(BR2_PACKAGE_LIBUNWIND),y)
XWAYLAND_CONF_OPTS += -Dlibunwind=true
XWAYLAND_DEPENDENCIES += libunwind
else
XWAYLAND_CONF_OPTS += -Dlibunwind=false
endif

# Mesa 24.0 removed dri.pc (classic DRI drivers were dropped). Xwayland 24.1.x
# has a hard dependency on it in include/meson.build which fails the meson
# configure step. Make dri optional and fall back to libdrm's include path,
# which carries the same DRI headers in any Mesa 24.x sysroot.
define XWAYLAND_FIX_DRI_DEP
	$(HOST_DIR)/bin/python3 $(BR2_EXTERNAL_NBOSP_PATH)/overrides/xwayland/fix-dri-dep.py $(@D)/include/meson.build
endef
XWAYLAND_POST_PATCH_HOOKS += XWAYLAND_FIX_DRI_DEP

$(eval $(meson-package))
