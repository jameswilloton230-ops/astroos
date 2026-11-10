#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/reboot.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	int command;

	if (geteuid() != 0) {
		fprintf(stderr, "nbosp-power must be installed as a root-owned setuid binary\n");
		return 1;
	}
	if (argc != 2) {
		fprintf(stderr, "Usage: nbosp-power {restart|poweroff}\n");
		return 2;
	}
	if (strcmp(argv[1], "restart") == 0) {
		command = RB_AUTOBOOT;
	} else if (strcmp(argv[1], "poweroff") == 0) {
		command = RB_POWER_OFF;
	} else {
		fprintf(stderr, "Unsupported power action\n");
		return 2;
	}

	sync();
	if (reboot(command) == -1) {
		fprintf(stderr, "Power action failed: %s\n", strerror(errno));
		return 1;
	}
	return 0;
}
