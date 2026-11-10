################################################################################
#
# m4 (host only)
#
################################################################################

# 1.4.19's bundled gnulib puts _GL_ATTRIBUTE_NODISCARD between the inline
# specifier and the return type. GCC 13+ (ubuntu-latest) expands it to
# [[nodiscard]] and rejects that placement, so lib/gl_avltree_oset.o fails to
# build. 1.4.21 ships a newer gnulib that fixes it; this is the same bump
# Buildroot master made. A configure-time cache override doesn't work here:
# the 1.4.19 gnulib has no probe for it.
M4_VERSION = 1.4.21
M4_SOURCE = m4-$(M4_VERSION).tar.xz
M4_SITE = $(BR2_GNU_MIRROR)/m4
M4_LICENSE = GPL-3.0+
M4_LICENSE_FILES = COPYING

$(eval $(host-autotools-package))
