ASTROOS_KIOSK_VERSION = 1
ASTROOS_KIOSK_SITE = $(BR2_EXTERNAL_ASTROOS_PATH)/package/astroos-kiosk/source
ASTROOS_KIOSK_SITE_METHOD = local

define ASTROOS_KIOSK_INSTALL_TARGET_CMDS
	rm -rf $(TARGET_DIR)/opt/astroos
	$(INSTALL) -d $(TARGET_DIR)/opt/astroos
	cp -a $(@D)/. $(TARGET_DIR)/opt/astroos/
	chmod 0755 $(TARGET_DIR)/opt/astroos/package.nw \
		$(TARGET_DIR)/opt/astroos/package.nw/js \
		$(TARGET_DIR)/opt/astroos/package.nw/js/apps
	chmod 0644 $(TARGET_DIR)/opt/astroos/package.nw/js/apps/novaapp-manifest.json
	test -f $(TARGET_DIR)/opt/astroos/lib/libffmpeg.so
	$(INSTALL) -d $(TARGET_DIR)/usr/lib
	ln -sf /opt/astroos/lib/libffmpeg.so $(TARGET_DIR)/usr/lib/libffmpeg.so
	$(INSTALL) -D -m 0600 $(BR2_EXTERNAL_ASTROOS_PATH)/board/astroos/astroos-wired.nmconnection \
		$(TARGET_DIR)/etc/NetworkManager/system-connections/astroos-wired.nmconnection
	$(INSTALL) -D -m 0755 $(BR2_EXTERNAL_ASTROOS_PATH)/board/astroos/S99astroos \
		$(TARGET_DIR)/etc/init.d/S99astroos
	$(INSTALL) -D -m 0755 $(BR2_EXTERNAL_ASTROOS_PATH)/board/astroos/astroos-recovery \
		$(TARGET_DIR)/usr/sbin/astroos-recovery
endef

$(eval $(generic-package))
