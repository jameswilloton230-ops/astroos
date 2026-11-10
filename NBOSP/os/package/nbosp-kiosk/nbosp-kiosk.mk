NBOSP_KIOSK_VERSION = 1
NBOSP_KIOSK_SITE = $(BR2_EXTERNAL_NBOSP_PATH)/package/nbosp-kiosk/source
NBOSP_KIOSK_SITE_METHOD = local

define NBOSP_KIOSK_INSTALL_TARGET_CMDS
	rm -rf $(TARGET_DIR)/opt/nbosp
	$(INSTALL) -d $(TARGET_DIR)/opt/nbosp
	cp -a $(@D)/. $(TARGET_DIR)/opt/nbosp/
	chmod 0755 $(TARGET_DIR)/opt/nbosp/package.nw \
		$(TARGET_DIR)/opt/nbosp/package.nw/js \
		$(TARGET_DIR)/opt/nbosp/package.nw/js/apps
	chmod 0644 $(TARGET_DIR)/opt/nbosp/package.nw/js/apps/novaapp-manifest.json
	test -f $(TARGET_DIR)/opt/nbosp/lib/libffmpeg.so
	$(INSTALL) -d $(TARGET_DIR)/usr/lib
	ln -sf /opt/nbosp/lib/libffmpeg.so $(TARGET_DIR)/usr/lib/libffmpeg.so
	$(INSTALL) -D -m 0600 $(BR2_EXTERNAL_NBOSP_PATH)/board/nbosp/nbosp-wired.nmconnection \
		$(TARGET_DIR)/etc/NetworkManager/system-connections/nbosp-wired.nmconnection
	$(INSTALL) -D -m 0755 $(BR2_EXTERNAL_NBOSP_PATH)/board/nbosp/S99nbosp \
		$(TARGET_DIR)/etc/init.d/S99nbosp
	$(INSTALL) -D -m 0755 $(BR2_EXTERNAL_NBOSP_PATH)/board/nbosp/nbosp-recovery \
		$(TARGET_DIR)/usr/sbin/nbosp-recovery
endef

$(eval $(generic-package))
