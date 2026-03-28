import { Strategy } from "../../types/strategies";
import { deadzone_orb_asymmetric_short } from "./deadzone_orb_asymmetric_short";

export const deadzone_orb_asymmetric_short_exact: Strategy = {
	...deadzone_orb_asymmetric_short,
	name: "Deadzone ORB Asymmetric Short Exact",
	description:
		"Exact wrapper for the raw Deadzone ORB Asymmetric Short signal stream. Use Direction Mode = short to match the mirrored ensemble-derived short workflow after loading and rerunning the anchor config directly."
};
