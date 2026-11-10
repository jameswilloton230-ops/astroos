NBOSP_INSTALL_VERSION = 1
NBOSP_INSTALL_SITE = $(BR2_EXTERNAL_NBOSP_PATH)/package/nbosp-install
NBOSP_INSTALL_SITE_METHOD = local

define NBOSP_INSTALL_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/nbosp-install.c -o $(@D)/nbosp-install
endef

define NBOSP_INSTALL_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 4755 $(@D)/nbosp-install $(TARGET_DIR)/usr/bin/nbosp-install
	$(INSTALL) -D -m 0755 $(@D)/nbosp-install-system \
		$(TARGET_DIR)/usr/sbin/nbosp-install-system
endef

$(eval $(generic-package))
