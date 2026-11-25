package com.englishcoach.exams.content;

import java.util.List;

import static com.englishcoach.exams.content.ExamContentPackage.ValidationError;

/** Sanitized, actionable validation failure for admin package operations. */
public final class ExamContentPackageValidationException extends IllegalArgumentException {

    private final List<ValidationError> errors;

    public ExamContentPackageValidationException(List<ValidationError> errors) {
        super("CONTENT_PACKAGE_INVALID: " + summarize(errors));
        this.errors = errors == null ? List.of() : List.copyOf(errors);
    }

    public List<ValidationError> errors() {
        return errors;
    }

    private static String summarize(List<ValidationError> errors) {
        if (errors == null || errors.isEmpty()) return "package failed validation";
        return errors.stream().limit(3)
                .map(e -> e.code() + " at " + e.path())
                .reduce((left, right) -> left + "; " + right)
                .orElse("package failed validation");
    }
}
