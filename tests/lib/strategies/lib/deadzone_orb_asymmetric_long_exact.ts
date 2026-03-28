import { Strategy } from "../../types/strategies";
import { deadzone_orb_asymmetric_long } from "./deadzone_orb_asymmetric_long";

export const deadzone_orb_asymmetric_long_exact: Strategy = {
	...deadzone_orb_asymmetric_long,
	name: "Deadzone ORB Asymmetric Long Exact",
	description:
		"Exact wrapper for the raw Deadzone ORB Asymmetric Long signal stream. Use Direction Mode = long to match the ensemble-derived long workflow after loading and rerunning the anchor config directly."
};
