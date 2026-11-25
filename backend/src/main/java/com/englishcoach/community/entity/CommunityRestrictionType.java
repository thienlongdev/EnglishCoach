package com.englishcoach.community.entity;

public enum CommunityRestrictionType {
    SUSPEND_COMMUNITY, // Cannot create posts, cannot comment/reply, cannot react
    READ_ONLY,         // Can view community, cannot create posts, cannot comment/reply
    NO_POST,           // Can view and comment, cannot create posts
    NO_COMMENT         // Can view and post, cannot comment or reply
}
