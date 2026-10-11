// Native instrument rig for iOS: interface input -> gain -> NAM amp -> cab IR -> gain -> monitor out, plus the processed
// signal and an optional voice input (separate streams) sent to the page for the call. Speaks the desktop engine's protocol
// (src/rig/native.ts): JSON messages in, JSON messages out; Float32 sample arrays travel as base64 in `samples`.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface TabshareEngine : NSObject
/// `emit` gets every engine -> page message as a JSON string, on a background queue.
- (instancetype)initWithEmitter:(void (^)(NSString *json))emit;
/// One page -> engine message (JSON). Returns immediately; slow work (model loading) happens on a background queue.
- (void)handle:(NSString *)json;
- (void)shutdown;
@end

NS_ASSUME_NONNULL_END
