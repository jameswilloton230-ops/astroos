# Load NBOSP packages from the external tree.
include $(sort $(wildcard $(BR2_EXTERNAL_NBOSP_PATH)/package/*/*.mk))
