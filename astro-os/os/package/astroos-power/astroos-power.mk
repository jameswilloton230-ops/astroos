ASTROOS_POWER_VERSION = 1
ASTROOS_POWER_SITE = $(BR2_EXTERNAL_ASTROOS_PATH)/package/astroos-power
ASTROOS_POWER_SITE_METHOD = local

define ASTROOS_POWER_BUILD_CMDS
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) \
		$(@D)/astroos-power.c -o $(@D)/astroos-power
endef

define ASTROOS_POWER_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 4755 $(@D)/astroos-power $(TARGET_DIR)/usr/bin/astroos-power
endef

$(eval $(generic-package))
