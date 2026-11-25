package com.englishcoach.echolife;

import com.englishcoach.echolife.EchoLifeDtos.World;
import com.englishcoach.echolife.EchoLifeGameDtos.Game;

/** A refused Echo Life command: HTTP status + stable public code (never internals); a conflict carries the current world or game. */
public final class EchoLifeException extends RuntimeException {

    final int status;
    final String code;
    final transient World current;
    final transient Game currentGame;

    public EchoLifeException(int status, String code) {
        this(status, code, null, null);
    }

    public EchoLifeException(int status, String code, World current) {
        this(status, code, current, null);
    }

    public EchoLifeException(int status, String code, World current, Game currentGame) {
        super(code);
        this.status = status;
        this.code = code;
        this.current = current;
        this.currentGame = currentGame;
    }
}
