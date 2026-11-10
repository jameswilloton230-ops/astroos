NOTO_EMOJI_VERSION = e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e
NOTO_EMOJI_SOURCE = NotoColorEmoji.ttf
NOTO_EMOJI_SITE = https://raw.githubusercontent.com/googlefonts/noto-emoji/$(NOTO_EMOJI_VERSION)/2D/fonts
NOTO_EMOJI_EXTRA_DOWNLOADS = $(NOTO_EMOJI_SITE)/LICENSE
NOTO_EMOJI_LICENSE = OFL-1.1
NOTO_EMOJI_LICENSE_FILES = LICENSE

define NOTO_EMOJI_EXTRACT_CMDS
	mkdir -p $(@D)
	cp $(NOTO_EMOJI_DL_DIR)/$(NOTO_EMOJI_SOURCE) $(@D)/NotoColorEmoji.ttf
	cp $(NOTO_EMOJI_DL_DIR)/LICENSE $(@D)/LICENSE
endef

define NOTO_EMOJI_INSTALL_TARGET_CMDS
	$(INSTALL) -D -m 0644 $(@D)/NotoColorEmoji.ttf \
		$(TARGET_DIR)/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf
	$(INSTALL) -D -m 0644 $(@D)/LICENSE \
		$(TARGET_DIR)/usr/share/licenses/noto-emoji/OFL.txt
endef

$(eval $(generic-package))
