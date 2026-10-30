import jsStringEscape from 'js-string-escape';

export class StringUtils {
    /**
     * Matches an unpaired (lone) UTF-16 surrogate code unit: a high surrogate not followed by a
     * low surrogate, or a low surrogate not preceded by a high surrogate.
     *
     * @type {RegExp}
     */
    private static readonly loneSurrogatesRegExp: RegExp =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

    /**
     * @param {string} string
     * @returns {string}
     */
    public static escapeJsString(string: string): string {
        // `js-string-escape` escapes quotes, backslashes, newlines and line/paragraph separators,
        // but passes lone surrogate code units through unchanged. Emitting a raw lone surrogate
        // into the generated source corrupts it to U+FFFD the moment the output is written as
        // UTF-8 (the universal output path), silently changing any such string literal. Escape
        // lone surrogates to `\uXXXX` after the base escaping (valid surrogate pairs are left
        // intact, so astral characters are unaffected).
        return StringUtils.escapeLoneSurrogates(jsStringEscape(string));
    }

    /**
     * @param {string} string
     * @returns {string}
     */
    private static escapeLoneSurrogates(string: string): string {
        return string.replace(
            StringUtils.loneSurrogatesRegExp,
            (surrogate: string): string => `\\u${surrogate.charCodeAt(0).toString(16).padStart(4, '0')}`
        );
    }
}
