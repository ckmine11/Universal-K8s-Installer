// Public sign-up: always on KubeEZ cloud; on a self-hosted server only when
// the operator opens it (KUBEEZ_OPEN_SIGNUP=true) — there an admin adds members.
export const signupOpen = () => process.env.KUBEEZ_MODE === 'saas' || process.env.KUBEEZ_OPEN_SIGNUP === 'true'
