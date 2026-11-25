package com.englishcoach.messenger;

import java.text.Normalizer;
import java.util.Locale;

/** A search query folded exactly as ec_fold_name folds a name in the database (V115): marks off, đ to d, lower case, only letters and digits between single spaces. */
final class MessengerNames {
    private MessengerNames() {}

    static String fold(String raw) {
        if (raw == null) return "";
        String plain = Normalizer.normalize(raw, Normalizer.Form.NFD).replaceAll("[\\u0300-\\u036F]", "").replace('đ', 'd').replace('Đ', 'D');
        return plain.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", " ").trim();
    }
}
