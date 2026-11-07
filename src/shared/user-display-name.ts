/**
 * How a person is named in text the bot writes (the prompt roster, the group
 * notice of a panel issue): the first name, then the last name when there is
 * one — never the @username, which would mention them.
 */
export interface UserNameParts {
    readonly firstName: string;
    /** Absent, null and '' all mean "no last name" */
    readonly lastName?: string | null;
}

export const formatUserDisplayName = (user: UserNameParts): string =>
    user.lastName ? `${user.firstName} ${user.lastName}` : user.firstName;
