#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int all_digits(const char *start, const char *end)
{
	if (start == end)
		return 0;
	for (const char *p = start; p < end; p++) {
		if (!isdigit((unsigned char)*p))
			return 0;
	}
	return 1;
}

static int valid_device_name(const char *name)
{
	size_t length = strlen(name);

	if ((length == 3 && !strncmp(name, "sd", 2) && islower((unsigned char)name[2])) ||
	    (length == 3 && !strncmp(name, "vd", 2) && islower((unsigned char)name[2])))
		return 1;
	if (!strncmp(name, "nvme", 4)) {
		const char *namespace = strchr(name + 4, 'n');
		return namespace && all_digits(name + 4, namespace) &&
		       all_digits(namespace + 1, name + length);
	}
	if (!strncmp(name, "mmcblk", 6))
		return all_digits(name + 6, name + length);
	return 0;
}

int main(int argc, char **argv)
{
	char device_path[64];
	char confirmation[80];
	struct stat status;
	char *const child_argv[] = {
		"/usr/sbin/nbosp-install-system",
		device_path,
		NULL
	};
	char *const child_env[] = {
		"PATH=/bin:/sbin:/usr/bin:/usr/sbin",
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		NULL
	};

	if (geteuid() != 0) {
		fprintf(stderr, "NBOSP installer helper is not running with root privileges\n");
		return 1;
	}
	if (argc != 3 || strncmp(argv[1], "/dev/", 5) ||
	    !valid_device_name(argv[1] + 5)) {
		fprintf(stderr, "Usage: nbosp-install /dev/{sdX|vdX|nvmeXnX|mmcblkX} ERASE:/dev/device\n");
		return 2;
	}
	if (snprintf(device_path, sizeof(device_path), "%s", argv[1]) >=
	    (int)sizeof(device_path)) {
		fprintf(stderr, "Device path is too long\n");
		return 2;
	}
	if (snprintf(confirmation, sizeof(confirmation), "ERASE:%s", device_path) >=
	    (int)sizeof(confirmation) || strcmp(argv[2], confirmation)) {
		fprintf(stderr, "Disk erase confirmation did not match the selected device\n");
		return 2;
	}
	if (lstat(device_path, &status) == -1 || !S_ISBLK(status.st_mode)) {
		fprintf(stderr, "Selected path is not a block device: %s\n", device_path);
		return 2;
	}
	if (setgid(0) == -1 || setuid(0) == -1) {
		fprintf(stderr, "Could not assume the required root identity: %s\n",
			strerror(errno));
		return 1;
	}
	umask(022);
	execve(child_argv[0], child_argv, child_env);
	fprintf(stderr, "Could not start the installer: %s\n", strerror(errno));
	return 1;
}
