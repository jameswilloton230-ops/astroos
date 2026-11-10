# Load AstroOS packages from the external tree.
include $(sort $(wildcard $(BR2_EXTERNAL_ASTROOS_PATH)/package/*/*.mk))
