NBOSP_POWER_VERSION = 1
NBOSP_POWER_SITE = $(BR2_EXTERNAL_NBOSP_PATH)/package/nbosp-power
NBOSP_POWER_SITE_METHOD = local

define NBOSP_POWER_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/nbosp-power.c -o $(@D)/nbosp-power
endef

define NBOSP_POWER_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 4755 $(@D)/nbosp-power $(TARGET_DIR)/usr/bin/nbosp-power
endef

$(eval $(generic-package))
