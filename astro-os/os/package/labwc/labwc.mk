################################################################################
#
# labwc
#
################################################################################

LABWC_VERSION = 0.20.3
LABWC_SITE = $(call github,labwc,labwc,$(LABWC_VERSION))
LABWC_LICENSE = GPL-2.0
LABWC_LICENSE_FILES = LICENSE
LABWC_DEPENDENCIES = \
	host-pkgconf \
	cairo \
	libglib2 \
	libinput \
	libpng \
	libxcb \
	libxkbcommon \
	libxml2 \
	pango \
	pixman \
	wayland \
	wayland-protocols \
	wlroots \
	xcb-util-wm

# The kiosk runs a single fullscreen NW.js X11 window through XWayland, so
# xwayland support is mandatory; decorative extras (SVG window buttons,
# window icons via libsfdo, the labnag notification daemon, man pages and
# NLS) are stripped to keep the image small. The rc.xml shipped in the
# AstroOS rootfs overlay (/etc/labwc/rc.xml) configures the bindings.
LABWC_CONF_OPTS = \
	-Dxwayland=enabled \
	-Dsvg=disabled \
	-Dicon=disabled \
	-Dlabnag=disabled \
	-Dman-pages=disabled \
	-Dnls=disabled \
	-Dsystemd-session=disabled

$(eval $(meson-package))
