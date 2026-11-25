package com.englishcoach.messenger;

/** What the Messenger asks of Speaking Arena: the code of a private room these two people may enter. Nobody is placed in it by this. */
public interface ArenaInvites {
    String reserve(String mode, long inviter, long invitee);

    default String boundRoom(java.util.UUID room,long inviter,long invitee,String mode,boolean admit){ throw new IllegalStateException("Room binding unavailable"); }

    /** Rooms live in memory: an old accepted invitation must not keep offering a room that has closed. */
    default boolean isOpen(String code) { return true; }
}
