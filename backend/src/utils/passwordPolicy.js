// One password rule for every place a password is set (setup, register,
// reset, change-password, team members). Existing passwords keep working.
export const MIN_PASSWORD_LENGTH = 8

export function passwordProblem(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    }
    if (password.length > 128) return 'Password is too long'
    if (/^(.)\1+$/.test(password) || /^(password|12345678|123456789|qwertyui|letmein1)$/i.test(password)) {
        return 'Password is too easy to guess'
    }
    return null
}
