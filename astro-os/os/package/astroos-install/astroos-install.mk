ASTROOS_INSTALL_VERSION = 1
ASTROOS_INSTALL_SITE = $(BR2_EXTERNAL_ASTROOS_PATH)/package/astroos-install
ASTROOS_INSTALL_SITE_METHOD = local

define ASTROOS_INSTALL_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/astroos-install.c -o $(@D)/astroos-install
endef

define ASTROOS_INSTALL_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 4755 $(@D)/astroos-install $(TARGET_DIR)/usr/bin/astroos-install
	$(INSTALL) -D -m 0755 $(@D)/astroos-install-system \
		$(TARGET_DIR)/usr/sbin/astroos-install-system
endef

$(eval $(generic-package))
